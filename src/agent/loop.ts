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
import type Anthropic from '@anthropic-ai/sdk';
import { estimateTokens } from '../context/candidates.js';
import { estimateCostUsd, perTokenRates } from '../execution/pricing.js';
import { expectedRemainingTurns, type Prices } from '../infocontrol/economics.js';
import type { StructuredEvent } from '../adapters/adapter.js';
import type { DispatchUsage } from '../execution/tokens.js';
import { canCompact, compact, priceCompaction, type CallRecord, type CompactionResult } from './compaction.js';
import { ModelError, modelProfile, resolveModelId, type ContentBlock, type Message, type MessageParam, type ModelClient, type Tool } from './model-client.js';

/** Server-side web search: $10 per 1000 searches, on top of tokens. */
export const WEB_SEARCH_USD = 0.01;
/** Searches per model turn (the server's own loop). */
const WEB_SEARCH_MAX_USES = 5;

export const CONFIRM_FINISH = 'Before you finish: if the task is fully done and verified against every requirement, reply with your final summary and no tool call. If anything is still unchecked, or you meant to run, read or fix something, do it now.';
import type { HookHandler, ToolBroker, ToolOutcome } from './tools.js';

export interface SessionState extends HookHandler {
  /** The canonical task state, rendered for the model. */
  activeState(): string;
  observeEvent(event: StructuredEvent): void;
  /** Changes only on real progress (a new file edited, a check run after an
   *  edit or not, a different call failing): when the state is worth reciting. */
  progressSignature?(): string;
}

export interface AgentSessionInput {
  sessionId: string;
  goal: string;
  /** The task-stable contract (role prompt, constraints), after the harness policy. */
  systemPrompt?: string;
  /** Where the sandbox's work directory is, for the harness policy. */
  workdir: string;
  /** What the work directory holds at the start (`workdirSnapshot`), shown
   *  after the goal in the first message. */
  orientation?: string;
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
  /** Append the task state after a tool round whenever it changed (default on). */
  recite?: boolean;
  /** Waits before re-trying a turn that failed transiently; its length is the retry budget. */
  retryDelaysMs?: readonly number[];
  /** Thinking tokens per turn for a budget-thinking model (Haiku). */
  thinkingBudget?: number;
  /** Offer server-side web search when the grant allows it (default on). */
  webSearch?: boolean;
  /** Ask once, when the model stops without a tool call, whether it is really
   *  done (default on): HarnessBridge's premature-submission check and ToFu's
   *  critic gate, applied to the one moment a run can end too early. */
  confirmFinish?: boolean;
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

/** The harness policy: how to work, the same ground Claude Code's own system
 *  prompt covers, written for this harness and its tools. Frozen for every
 *  session (it is the start of the 1-hour cached prefix), so its length is paid
 *  for once per hour, not per turn. Measured reason it is long: the 600-byte
 *  version it replaces lost on every long Terminal-Bench task it was run on. */
export const HARNESS_POLICY = `You are an autonomous software engineering agent. You work alone inside an isolated sandbox on one task, using the tools provided. Nobody will answer questions or approve steps while you work: make reasonable decisions yourself and keep going until the task is completely done.

# How to work
- Understand before acting. Read the task carefully, then look at the relevant files, the existing tests, build files and documentation. Find the real mechanism the task is about before changing anything; do not pattern-match on keywords.
- Plan multi-step work. For anything with three or more steps, write the steps down with TodoWrite, keep exactly one step in progress, and mark each step completed as soon as it is done.
- Make the change the task asks for, in the style of the surrounding code. Do not rename, reformat or refactor unrelated code. Never delete or rewrite the task's own input files, data or tests to make a check pass, unless the task explicitly asks for it.
- Install what you need. If a tool, package or runtime is missing, install it (apt-get, pip, npm and so on) and continue; long installs and builds are normal, wait for them.
- Verify your work for real. Run the task's own tests or checks when they exist; otherwise run the program the way the task describes and check its actual output against every requirement stated in the task. A script you wrote that only re-states your own assumptions is not verification. If the task names output files, formats, paths or exact values, check each one exactly.
- When something fails, read the error, find the cause, and fix it; do not repeat a failing command unchanged, and do not paper over failures. If an approach is clearly not working, step back and try a different one.
- Before finishing, re-read the task and check every requirement against what you actually produced.

# Using the tools
- Every response either calls at least one tool or is your final answer. Never end a response by saying what you are about to do: if you intend to run, read or check something, make that tool call in the same response.
- Prefer Read, Grep and Glob for looking at files and Edit or Write for changing them; use Bash for running programs, tests, builds and installs. Read a file before editing or overwriting it.
- When several independent lookups or commands are needed, issue them together in one response; they run in order and all results come back at once.
- Use Task to hand a broad, self-contained investigation to a sub-agent when doing it yourself would flood your context. Use web search only when the answer is not in the sandbox.
- Outputs that are too long are shortened and the full text is saved to a file whose path is shown; read that file (with offset/limit) when you need what was left out. Never conclude that something succeeded from a shortened preview.
- Messages marked [CherryOnTop: …] come from the harness: they report the task state (files you changed, whether your latest change has been checked, the last failure, your task list). Treat them as accurate.

# Finishing
When, and only when, the task is fully done and verified, reply without a tool call: a short summary of what you changed and how you verified it. If you could not complete something, say exactly what and why.`;

/** The loop's own iteration ceiling when the dispatch sets none: a guard
 *  against a runaway, not a budget (the spend limit is the budget). Claude Code
 *  has none at all and used 105 turns on a Terminal-Bench build task. */
export const DEFAULT_MAX_TURNS = 200;
/** Re-tries of a turn lost to the network or an overloaded provider, with
 *  backoff (ToFu re-runs an interrupted stream; the SDK already retries
 *  before a stream starts). A failed attempt never ran a tool. */
export const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];
/** The share of the context the verbatim tail may keep through a compaction
 *  (the Harness Effect keeps at most 30% of the budget verbatim). */
export const TAIL_SHARE = 0.3;

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

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

/** The active state without its goal line (the goal opens the conversation
 *  already); empty when nothing has happened worth reciting. */
export function recitable(activeState: string, goal: string): string {
  const head = `Goal: ${goal.trim().slice(0, 600)}`;
  return (activeState.startsWith(head) ? activeState.slice(head.length) : activeState).trim();
}

function textOf(message: Message): string {
  return message.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n').trim();
}

export async function runAgentSession(input: AgentSessionInput): Promise<AgentSessionResult> {
  const model = resolveModelId(input.model);
  const prices = ownedPrices(model);
  const system = systemPromptFor(input);
  const profile = modelProfile(model);
  const tools: Tool[] = [
    ...input.broker.definitions,
    ...(input.webSearch !== false && input.broker.allowsWebSearch
      ? [{ type: profile.webSearchType, name: 'web_search', max_uses: WEB_SEARCH_MAX_USES } as Tool] : []),
  ];
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
  const opening = input.orientation ? `${input.goal}\n\n${input.orientation}` : input.goal;
  let messages: MessageParam[] = [{ role: 'user', content: opening }];
  let lastContext = 0;
  let appendedSince = estimateTokens(opening);
  let compactions = 0;
  let compactedBeforeTurn = false;
  let retriedAfterCompaction = false;
  let finalText = '';
  const started = Date.now();
  // 1-hour cache writes (the stable prefix) bill at 2x input, not the 1.25x
  // estimateCostUsd assumes for every write: the difference, from the API's
  // own split of each turn's cache writes.
  let write1h = 0;
  const premium1h = perTokenRates(model).input * 0.75;
  /** Spend outside the token price list: web searches, and the 1-hour-write
   *  premium and searches of sub-agents. */
  let extraUsd = 0;
  const cost = () => estimateCostUsd(usage, model) + write1h * premium1h + extraUsd;
  const tailBudget = () => TAIL_SHARE * (lastContext + appendedSince);
  // A budget-thinking model (Haiku) must see its thinking on the turn whose
  // tool round is in flight; it has no history-binding check, so compaction
  // keeps those blocks. Adaptive models bind thinking to the prefix, so a
  // compacted (re-prefixed) history carries none.
  const keepThinking = profile.thinking === 'budget';
  const stateForModel = () => {
    const todos = input.broker.todos();
    return todos ? `${input.state.activeState()}\nTask list:\n${todos}` : input.state.activeState();
  };
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
  const retryDelays = input.retryDelaysMs ?? RETRY_DELAYS_MS;
  let retries = 0;
  /** The progress signature and task list last recited: recited again only when one moved. */
  let recitedSignature = '';
  let recitedTodos = '';
  let confirmedFinish = false;

  emit('system', { subtype: 'init', model, cwd: input.workdir, tools: tools.map((t) => ('name' in t ? t.name : t.type)), runtime: 'anthropic-owned', ...(input.effort ? { effort: input.effort } : {}) });

  const doCompact = (reason: 'window' | 'priced' | 'recovery', precomputed?: CompactionResult): boolean => {
    const result = precomputed ?? compact({ goal: input.goal, messages, activeState: stateForModel(), calls, tailBudget: tailBudget(), keepThinking });
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
    if (usage.numTurns >= maxTurns) return finish('max_turns');
    if (input.spendLimitUsd !== undefined && cost() >= input.spendLimitUsd) return finish('spend_limit');

    // Compaction: forced by the window, otherwise only when it pays.
    const projected = lastContext + appendedSince;
    if (projected + maxTokens > window && canCompact(messages)) doCompact('window');
    else if (input.pricedCompaction !== false && canCompact(messages) && usage.numTurns > 0) {
      const preview = compact({ goal: input.goal, messages, activeState: stateForModel(), calls, tailBudget: tailBudget(), keepThinking });
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
      message = await input.client.createTurn({
        model, maxTokens, system, tools, messages,
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.thinkingBudget !== undefined ? { thinkingBudget: input.thinkingBudget } : {}),
      }, input.signal);
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
      // Lost to the network or an overloaded provider: the same request again,
      // after a wait. Bounded, receipted, and nothing ran on the lost attempt.
      if ((error.kind === 'network' || error.kind === 'overloaded') && retries < retryDelays.length) {
        emit('owned.retry', { kind: error.kind, attempt: retries + 1, waitMs: retryDelays[retries], message: error.message.slice(0, 300) });
        await sleep(retryDelays[retries++], input.signal);
        continue;
      }
      if (error.kind === 'rate_limit') emit('rate_limit_event', { rate_limit_info: { status: 'rejected', rateLimitType: 'api' } });
      return finish('model_error', error);
    }
    retriedAfterCompaction = false;
    retries = 0;
    usage.numTurns++;
    const u = message.usage;
    usage.inputTokens += u.input_tokens ?? 0;
    usage.outputTokens += u.output_tokens ?? 0;
    usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    usage.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
    write1h += (u as { cache_creation?: { ephemeral_1h_input_tokens?: number } | null }).cache_creation?.ephemeral_1h_input_tokens ?? 0;
    extraUsd += ((u as { server_tool_use?: { web_search_requests?: number } | null }).server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD;
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
          : await input.broker.execute({ id: call.id, name: call.name, input: call.input },
            input.spendLimitUsd !== undefined ? { remainingUsd: Math.max(0, input.spendLimitUsd - cost()) } : {});
        if (outcome.subagent) {
          // A sub-agent's spend is this dispatch's spend; its trace is part of
          // this dispatch's record, marked as the sub-agent's.
          const sub = outcome.subagent;
          usage.inputTokens += sub.usage.inputTokens;
          usage.outputTokens += sub.usage.outputTokens;
          usage.cacheReadTokens += sub.usage.cacheReadTokens;
          usage.cacheCreationTokens += sub.usage.cacheCreationTokens;
          extraUsd += Math.max(0, sub.costUsd - estimateCostUsd(sub.usage, model));
          for (const e of sub.events) {
            const type = e.type === 'result' || e.type === 'system' ? `subagent.${e.type}` : e.type;
            const event = { type, payload: { ...(e.payload as Record<string, unknown>), type, parent_tool_use_id: call.id } };
            events.push(event);
            input.onEvent?.(event);
          }
        }
        results.push({ id: call.id, outcome });
        calls.set(call.id, {
          id: call.id, name: call.name, target: describeTarget(call.name, call.input), isError: outcome.isError,
          ...(outcome.isError ? { error: outcome.content.trim().split('\n').find((l) => l.trim())?.slice(0, 160) ?? '' } : {}),
          ...(outcome.spilledTo ? { spilledTo: outcome.spilledTo } : {}),
        });
        decisions.push({ id: call.id, name: call.name, isError: outcome.isError, refusal: outcome.refusal ?? null, projected: outcome.projected, rawChars: outcome.raw.length, shownChars: outcome.content.length, ...(outcome.spilledTo ? { spilledTo: outcome.spilledTo } : {}) });
      }
      // All results in one user message: splitting them teaches the model to
      // stop making parallel calls.
      const blocks: Array<Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam> = results.map(({ id, outcome }) => ({ type: 'tool_result' as const, tool_use_id: id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) }));
      // Objective recitation, append-only: when the task state moved, say where
      // it stands now, after the results. Never edited or removed later, so the
      // cached prefix and earlier thinking blocks stay valid (a volatile tail
      // rebuilt each turn would break both on preserved-thinking models).
      if (input.recite !== false) {
        const signature = input.state.progressSignature?.() ?? input.state.activeState();
        const todos = input.broker.todos();
        const state = recitable(input.state.activeState(), input.goal);
        if ((signature !== recitedSignature || todos !== recitedTodos) && (state || todos)) {
          recitedSignature = signature;
          recitedTodos = todos;
          blocks.push({ type: 'text', text: `[CherryOnTop: task state]\n${[state, todos ? `Task list:\n${todos}` : ''].filter(Boolean).join('\n')}` });
        }
      }
      next = { role: 'user', content: blocks };
      emit('user', {
        message: next, parent_tool_use_id: null,
        tool_use_result: results.map(({ id, outcome }) => ({ tool_use_id: id, tool: toolUses.find((t) => t.id === id)?.name ?? null, raw: outcome.raw, projected: outcome.projected, refusal: outcome.refusal ?? null, spilledTo: outcome.spilledTo ?? null })),
      });
    } else if (message.stop_reason === 'pause_turn') {
      // The server's own tool loop (web search) paused: send the conversation
      // back as it is and it resumes. No user message: the API resumes from
      // the trailing server-tool block.
      receipt();
      continue;
    } else if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') {
      if (message.stop_reason === 'model_context_window_exceeded') doCompact('window');
      next = { role: 'user', content: 'Continue from where you stopped.' };
    } else {
      // The model is finishing. The finish gate may send it back to check its
      // work; otherwise it is asked once whether it is really done.
      const gate = await input.state.handle({ hook_event_name: 'Stop', last_assistant_message: text }).catch(() => ({}) as Record<string, unknown>);
      if (gate.decision === 'block' && typeof gate.reason === 'string') next = { role: 'user', content: gate.reason };
      else if (input.confirmFinish !== false && !confirmedFinish) {
        confirmedFinish = true;
        next = { role: 'user', content: CONFIRM_FINISH };
        emit('owned.confirm_finish', {});
      }
    }
    receipt();
    if (!next) return finish('end_turn');
    messages.push(next);
    appendedSince += estimateTokens(typeof next.content === 'string' ? next.content : JSON.stringify(next.content));

  }
}
