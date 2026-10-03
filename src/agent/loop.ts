/** The CherryOnTop-owned agent loop.
 *
 *      build request → model turn → record → run the tools it asked for
 *      (through the broker) → record → repeat, until the model finishes, a
 *      limit stops it, or the model cannot be reached
 *
 *  Three layers of history, as the design asks:
 *   1. the raw log — every event this loop emits, in Claude Code's own stream
 *      shape (assistant/user/result), with each tool's unprojected output on
 *      its `tool_use_result`; the caller persists them, nothing here forgets;
 *   2. the canonical task state — information control's active state, built
 *      from the trajectory itself and recited whenever history is compacted;
 *   3. the model context — `messages`, append-only between compactions, so
 *      every turn re-reads its prefix from cache and earlier thinking blocks
 *      stay valid.
 *
 *  The system prompt and tool definitions are fixed for the session: they
 *  are the stable prefix. Nothing volatile is ever written into them.
 *
 *  Each turn also emits an `owned.turn` receipt: context tokens by layer,
 *  cache traffic, spend, the tools' fate (ran, refused and by whom, projected,
 *  spilled), and whether the turn followed a compaction. */
import { estimateTokens } from '../context/candidates.js';
import { estimateCostUsd, perTokenRates } from '../execution/pricing.js';
import { expectedRemainingTurns, type Prices } from '../infocontrol/economics.js';
import type { StructuredEvent } from '../adapters/adapter.js';
import type { DispatchUsage } from '../execution/tokens.js';
import { canCompact, compact, priceCompaction, type CallRecord, type CompactionResult } from './compaction.js';
import { ModelError, resolveModelId, type ContentBlock, type Message, type MessageParam, type ModelClient } from './model-client.js';
import type { HookHandler, ToolBroker, ToolOutcome } from './tools.js';

export interface SessionState extends HookHandler {
  /** The canonical task state, rendered for the model. */
  activeState(): string;
  observeEvent(event: StructuredEvent): void;
}

export interface AgentSessionInput {
  sessionId: string;
  goal: string;
  /** The task-stable contract (role prompt, constraints), after the harness policy. */
  systemPrompt?: string;
  /** Where the sandbox's work directory is, for the harness policy. */
  workdir: string;
  model: string;
  effort?: string;
  client: ModelClient;
  broker: ToolBroker;
  state: SessionState;
  maxTurns?: number;
  spendLimitUsd?: number;
  /** Past dispatches' turn counts, for the expected-remaining-turns estimate. */
  pastTurns?: readonly number[];
  maxOutputTokens?: number;
  /** Compact when the price says so (default). Off: only when the window forces it. */
  pricedCompaction?: boolean;
  onEvent?(event: StructuredEvent): void;
  signal?: AbortSignal;
}

export type StopKind = 'end_turn' | 'max_turns' | 'spend_limit' | 'refusal' | 'model_error' | 'aborted';

export interface AgentSessionResult {
  stop: StopKind;
  succeeded: boolean;
  finalText: string;
  events: StructuredEvent[];
  usage: DispatchUsage;
  costUsd: number;
  compactions: number;
  error?: ModelError;
}

const HARNESS_POLICY = `You are an autonomous software engineering agent working on a task inside an isolated sandbox. Use the tools to inspect and change files and to run commands; nobody will answer questions mid-task, so make reasonable decisions and keep going until the task is done. Verify your change by running the narrowest relevant check before you finish. When you are done, reply with a short summary of what you changed and how you verified it, without calling a tool.`;

/** Context windows, tokens. Haiku 4.5 is the one current model below 1M. */
export function contextWindowFor(modelId: string): number {
  return modelId.includes('haiku') ? 200_000 : 1_000_000;
}

/** Per-token prices of an owned session: its cache entries use the API's
 *  5-minute TTL, written at 1.25x input (Claude Code writes 1-hour ones at 2x). */
export function ownedPrices(model: string): Prices {
  const p = perTokenRates(model);
  return { read: p.read, write: p.input * 1.25, output: p.output };
}

export function systemPromptFor(input: Pick<AgentSessionInput, 'workdir' | 'systemPrompt'>): string {
  return [HARNESS_POLICY, `The work directory is ${input.workdir}; tool paths may be absolute or relative to it.`, input.systemPrompt?.trim()]
    .filter(Boolean).join('\n\n');
}

function describeTarget(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const t = name === 'Bash' ? i.command : i.file_path ?? i.pattern ?? i.url ?? i.path;
  return t === undefined ? '' : String(t).replace(/\s+/g, ' ').slice(0, 160);
}

function textOf(message: Message): string {
  return message.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n').trim();
}

export async function runAgentSession(input: AgentSessionInput): Promise<AgentSessionResult> {
  const model = resolveModelId(input.model);
  const prices = ownedPrices(model);
  const system = systemPromptFor(input);
  const tools = input.broker.definitions;
  const maxTokens = input.maxOutputTokens ?? 64_000;
  const window = contextWindowFor(model);
  const fixedTokens = estimateTokens(system) + estimateTokens(JSON.stringify(tools));

  const events: StructuredEvent[] = [];
  const emit = (type: string, payload: Record<string, unknown>) => {
    const event = { type, payload: { type, ...payload, session_id: input.sessionId } };
    events.push(event);
    input.onEvent?.(event);
    return event;
  };
  const usage: DispatchUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 0 };
  const calls = new Map<string, CallRecord>();
  let messages: MessageParam[] = [{ role: 'user', content: input.goal }];
  let lastContext = 0;
  let appendedSince = estimateTokens(input.goal);
  let compactions = 0;
  let compactedBeforeTurn = false;
  let retriedAfterCompaction = false;
  let finalText = '';
  const started = Date.now();
  const cost = () => estimateCostUsd(usage, model);

  emit('system', { subtype: 'init', model, cwd: input.workdir, tools: tools.map((t) => t.name), runtime: 'anthropic-owned', ...(input.effort ? { effort: input.effort } : {}) });

  const doCompact = (reason: 'window' | 'priced' | 'recovery', precomputed?: CompactionResult): boolean => {
    const result = precomputed ?? compact({ goal: input.goal, messages, activeState: input.state.activeState(), calls });
    if (!result) return false;
    messages = result.messages;
    compactions++;
    compactedBeforeTurn = true;
    appendedSince = result.keptTokens + result.stateTokens + estimateTokens(input.goal);
    lastContext = fixedTokens;
    // Every pointer information control could make into the old history is gone.
    void input.state.handle({ hook_event_name: 'PostCompact' }).catch(() => {});
    emit('owned.compaction', { reason, droppedCallIds: result.droppedCallIds, retainedCallIds: result.retainedCallIds, droppedTokens: result.droppedTokens, keptTokens: result.keptTokens, stateTokens: result.stateTokens });
    return true;
  };

  const finish = (stop: StopKind, error?: ModelError): AgentSessionResult => {
    const succeeded = stop === 'end_turn';
    const message = stop === 'spend_limit' ? `Stopped: this run reached its $${(input.spendLimitUsd ?? 0).toFixed(2)} spend limit`
      : stop === 'max_turns' ? 'Stopped: reached the maximum number of turns'
      : stop === 'refusal' ? 'The model declined to continue (refusal)'
      : stop === 'aborted' ? 'Stopped: the dispatch timed out'
      : error ? `Model API error (${error.kind}): ${error.message}` : finalText;
    emit('result', {
      subtype: succeeded ? 'success' : stop === 'max_turns' ? 'error_max_turns' : 'error_during_execution',
      is_error: !succeeded, result: succeeded ? finalText : message, stop_reason: stop,
      num_turns: usage.numTurns, duration_ms: Date.now() - started, total_cost_usd: cost(), compactions,
      usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cache_read_input_tokens: usage.cacheReadTokens, cache_creation_input_tokens: usage.cacheCreationTokens },
      ...(error ? { error_kind: error.kind } : {}),
    });
    return { stop, succeeded, finalText, events, usage: { ...usage }, costUsd: cost(), compactions, ...(error ? { error } : {}) };
  };

  for (;;) {
    if (input.signal?.aborted) return finish('aborted');
    if (input.maxTurns !== undefined && usage.numTurns >= input.maxTurns) return finish('max_turns');
    if (input.spendLimitUsd !== undefined && cost() >= input.spendLimitUsd) return finish('spend_limit');

    // Compaction: forced by the window, otherwise only when it pays.
    const projected = lastContext + appendedSince;
    if (projected + maxTokens > window && canCompact(messages)) doCompact('window');
    else if (input.pricedCompaction !== false && canCompact(messages) && usage.numTurns > 0) {
      const preview = compact({ goal: input.goal, messages, activeState: input.state.activeState(), calls });
      if (preview) {
        const price = priceCompaction({
          droppedTokens: preview.droppedTokens, droppedCalls: preview.droppedCallIds.length, keptTokens: preview.keptTokens, stateTokens: preview.stateTokens,
          contextTokens: projected, outputPerTurn: usage.outputTokens / usage.numTurns,
          remainingTurns: expectedRemainingTurns(usage.numTurns, input.pastTurns ?? []), refetchProbability: 0.5,
        }, prices);
        if (price.worth) doCompact('priced', preview);
      }
    }

    let message: Message;
    try {
      message = await input.client.createTurn({ model, maxTokens, system, tools, messages, ...(input.effort ? { effort: input.effort } : {}) }, input.signal);
    } catch (err) {
      const error = err instanceof ModelError ? err : new ModelError('other', err instanceof Error ? err.message : String(err));
      if (input.signal?.aborted) return finish('aborted');
      // A refused request is most often a context that no longer fits (or
      // history the provider will not accept). Rebuilding it from state, once,
      // is the defined recovery; a second refusal is final.
      if (error.kind === 'bad_request' && !retriedAfterCompaction && doCompact('recovery')) {
        retriedAfterCompaction = true;
        continue;
      }
      if (error.kind === 'rate_limit') emit('rate_limit_event', { rate_limit_info: { status: 'rejected', rateLimitType: 'api' } });
      return finish('model_error', error);
    }
    retriedAfterCompaction = false;
    usage.numTurns++;
    const u = message.usage;
    usage.inputTokens += u.input_tokens ?? 0;
    usage.outputTokens += u.output_tokens ?? 0;
    usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    usage.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
    lastContext = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
    appendedSince = 0;
    const assistant = emit('assistant', { message, parent_tool_use_id: null });
    input.state.observeEvent(assistant);
    messages.push({ role: 'assistant', content: message.content as MessageParam['content'] });
    const text = textOf(message);
    if (text) finalText = text;

    const toolUses = message.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    const decisions: Array<Record<string, unknown>> = [];
    let next: MessageParam | null = null;
    const receipt = () => {
      const history = messages.slice(0, -1);
      emit('owned.turn', {
        turn: usage.numTurns, model, effort: input.effort ?? null, stopReason: message.stop_reason,
        usage: u, costUsd: estimateCostUsd({ inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheCreationTokens: u.cache_creation_input_tokens ?? 0 }, model),
        cumulativeCostUsd: cost(), compactedBefore: compactedBeforeTurn,
        layers: {
          systemTokens: estimateTokens(system), toolTokens: estimateTokens(JSON.stringify(tools)),
          historyTokens: history.reduce((s, m) => s + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 0),
          historyMessages: history.length,
        },
        tools: decisions,
      });
      compactedBeforeTurn = false;
    };

    if (message.stop_reason === 'refusal') {
      receipt();
      return finish('refusal');
    }
    if (toolUses.length > 0) {
      const results: Array<{ id: string; outcome: ToolOutcome }> = [];
      for (const call of toolUses) {
        // A turn cut off at max_tokens may carry a truncated tool input: never run it.
        const outcome: ToolOutcome = message.stop_reason === 'max_tokens'
          ? { content: 'Your response hit the output limit before this call was complete, so it did not run. Issue it again, smaller if it was large.', isError: true, raw: '', refusal: 'invalid', projected: false }
          : await input.broker.execute({ id: call.id, name: call.name, input: call.input });
        results.push({ id: call.id, outcome });
        calls.set(call.id, { id: call.id, name: call.name, target: describeTarget(call.name, call.input), isError: outcome.isError, ...(outcome.spilledTo ? { spilledTo: outcome.spilledTo } : {}) });
        decisions.push({ id: call.id, name: call.name, isError: outcome.isError, refusal: outcome.refusal ?? null, projected: outcome.projected, rawChars: outcome.raw.length, shownChars: outcome.content.length, ...(outcome.spilledTo ? { spilledTo: outcome.spilledTo } : {}) });
      }
      // All results in one user message: splitting them teaches the model to
      // stop making parallel calls.
      next = { role: 'user', content: results.map(({ id, outcome }) => ({ type: 'tool_result' as const, tool_use_id: id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) })) };
      emit('user', {
        message: next, parent_tool_use_id: null,
        tool_use_result: results.map(({ id, outcome }) => ({ tool_use_id: id, raw: outcome.raw, projected: outcome.projected, refusal: outcome.refusal ?? null, spilledTo: outcome.spilledTo ?? null })),
      });
    } else if (message.stop_reason === 'max_tokens' || message.stop_reason === 'pause_turn' || message.stop_reason === 'model_context_window_exceeded') {
      if (message.stop_reason === 'model_context_window_exceeded') doCompact('window');
      next = { role: 'user', content: 'Continue from where you stopped.' };
    } else {
      // The model is finishing. The finish gate may send it back once to check its work.
      const gate = await input.state.handle({ hook_event_name: 'Stop', last_assistant_message: text }).catch(() => ({}) as Record<string, unknown>);
      if (gate.decision === 'block' && typeof gate.reason === 'string') next = { role: 'user', content: gate.reason };
    }
    receipt();
    if (!next) return finish('end_turn');
    messages.push(next);
    appendedSince += estimateTokens(typeof next.content === 'string' ? next.content : JSON.stringify(next.content));

  }
}
