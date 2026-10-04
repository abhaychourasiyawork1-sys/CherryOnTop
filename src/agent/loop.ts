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
import { SPILL_DIR } from '../infocontrol/controller.js';
import { estimateTokens } from '../context/candidates.js';
import { estimateCostUsd, perTokenRates } from '../execution/pricing.js';
import { expectedRemainingTurns, type Prices } from '../infocontrol/economics.js';
import type { StructuredEvent } from '../adapters/adapter.js';
import type { DispatchUsage } from '../execution/tokens.js';
import { canCompact, compact, microCompact, priceCompaction, tailStart, transcriptForSummary, MOVED_MARK, SUMMARY_INSTRUCTIONS, type CallRecord, type CompactionResult } from './compaction.js';

/** The lightweight model that writes compaction summaries (ToFu uses a small
 *  model for its third layer): cheap, and its summary is all it is asked for. */
export const SUMMARY_MODEL = 'claude-haiku-4-5';
/** Share of the usable context (window minus the output reserve) at which the
 *  semantic layer fires: ToFu and the Harness Effect both summarize at ~80%. */
export const SEMANTIC_SHARE = 0.8;
import { ModelError, modelProfile, resolveModelId, type ContentBlock, type Message, type MessageParam, type ModelClient, type Tool } from './model-client.js';

/** Server-side web search: $10 per 1000 searches, on top of tokens. */
export const WEB_SEARCH_USD = 0.01;
/** Searches per model turn (the server's own loop). */
const WEB_SEARCH_MAX_USES = 5;

/** The one check before a run may end: a requirements audit against the task
 *  itself (ToFu's critic gate, HarnessBridge's premature-submission check),
 *  not a generic "are you sure". Measured misses it targets: an interface the
 *  tests call differently from how it was built, an output format or path not
 *  re-checked, a statement left as "I will check" with no check made. */
export const CONFIRM_FINISH = `Before you finish, audit your work against the task statement:
1. List every explicit requirement in the task: each file and path, output format, function name, argument and how it will be called (use the conventional calling form for that language, e.g. a vector where R users pass a vector), value, range and behaviour.
2. For each one, point to the command output from this session that proves it, or run the check now. Exercise your code the way the task's user or tests would call it, not only the way you wrote it.
3. If anything is unproven, wrong or assumed, fix and re-check it.
When every requirement is proven, reply with your final summary and no tool call.`;

/** Opens a continued attempt: what happened and what to do now. */
export const RESUME_NOTE = '[CherryOnTop: your previous attempt at this task, above, ended without being accepted. Its work is still in place. Continue from where it stands: re-check the result against every requirement of the task below, find what is missing or wrong, and fix it. Do not start over unless the existing work is unsalvageable.]';
import type { HookHandler, ToolBroker, ToolOutcome } from './tools.js';

export interface SessionState extends HookHandler {
  /** The canonical task state, rendered for the model. */
  activeState(): string;
  observeEvent(event: StructuredEvent): void;
  /** Changes only on real progress (a new file edited, a check run after an
   *  edit or not, a different call failing): when the state is worth reciting. */
  progressSignature?(): string;
  /** How many turns past dispatches of this role took (information control
   *  loads them from the ledger): what prices carrying a token to the end. */
  pastTurns?(): readonly number[];
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
  /** Also compact when the price says so. Off by default: measured on
   *  Terminal-Bench it compacted a trial-and-error task six times at ~12% of
   *  the window, rewriting the cache and dropping what had been tried each
   *  time, where Claude Code never compacted. The papers compact near the
   *  context budget (~80%), which the window rule below already does. */
  pricedCompaction?: boolean;
  /** A previous attempt at the same work, continued instead of restarted
   *  (the Harness Effect's durable resume; ToFu re-runs rather than restarts).
   *  Used only when the model, system prompt and tools are byte-identical,
   *  so the cached prefix and every thinking block stay valid. */
  resume?: Transcript;
  /** ToFu's second layer: every round, move cold bulky tool outputs out of the
   *  context behind recoverable placeholders, when the saving pays for the
   *  cache rewrite (default on). */
  microCompaction?: boolean;
  /** ToFu's third layer: near the context limit, a lightweight model writes a
   *  task-focused summary of the dropped turns (default on). Its failure falls
   *  back to the deterministic compaction. */
  semanticCompaction?: boolean;
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

/** What a later attempt needs to continue this one. */
export interface Transcript {
  model: string;
  system: string;
  toolsJson: string;
  messages: MessageParam[];
}

/** Where the context's tokens went over a session: the information-flow
 *  receipt. Token reduction is not the objective (quality × cost × latency
 *  is); these are what lets a run's context policy be judged against it. */
export interface ContextTelemetry {
  /** Tokens the tools produced, before any bound or projection. */
  toolRawTokens: number;
  /** Tokens of tool output the model was handed. */
  toolShownTokens: number;
  /** Micro-compaction (L2): outputs moved behind references, and the tokens that saved. */
  microCompactions: number;
  microSavedTokens: number;
  /** Compaction (L3 and the window rule): tokens dropped, and the state that replaced them. */
  compactions: number;
  compactionDroppedTokens: number;
  compactionStateTokens: number;
  /** What the semantic summaries cost. */
  summaryUsd: number;
  /** FetchResult calls, and the tokens they brought back: what externalizing cost in recovery. */
  fetches: number;
  fetchedTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** The result store at the end of the session, when there is one. */
  results?: import('./result-store.js').ResultStoreStats;
}

export interface AgentSessionResult {
  /** The conversation as it ended, for a retry to continue. */
  transcript: Transcript;
  stop: StopKind;
  succeeded: boolean;
  finalText: string;
  events: StructuredEvent[];
  usage: DispatchUsage;
  costUsd: number;
  compactions: number;
  context: ContextTelemetry;
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
  /** Each tool output as produced, for micro-compaction's placeholders. */
  const outputs = new Map<string, { raw: string; tool: string; filePath?: string; spilledTo?: string; resultUri?: string; fetched?: string }>();
  const resultStore = input.broker.results;
  let microCompactions = 0;
  const flow = {
    toolRawTokens: 0, toolShownTokens: 0, microSavedTokens: 0, compactionDroppedTokens: 0, compactionStateTokens: 0,
    summaryUsd: 0, fetches: 0, fetchedTokens: 0,
  };
  const opening = input.orientation ? `${input.goal}\n\n${input.orientation}` : input.goal;
  const toolsJson = JSON.stringify(tools);
  // A retry continues the previous attempt's conversation when nothing that
  // shapes the prefix changed; otherwise it starts clean, and says why.
  const resumable = input.resume !== undefined && input.resume.model === model && input.resume.system === system
    && input.resume.toolsJson === toolsJson && input.resume.messages.length > 0 && input.resume.messages.at(-1)?.role === 'assistant';
  let messages: MessageParam[] = resumable
    ? [...input.resume!.messages, { role: 'user', content: `${RESUME_NOTE}\n\n${opening}` }]
    : [{ role: 'user', content: opening }];
  let lastContext = 0;
  let appendedSince = estimateTokens(JSON.stringify(messages));
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

  if (input.resume) emit('owned.resume', { resumed: resumable, priorMessages: input.resume.messages.length, ...(resumable ? {} : { reason: 'model, system prompt or tools differ' }) });
  emit('system', { subtype: 'init', model, cwd: input.workdir, tools: tools.map((t) => ('name' in t ? t.name : t.type)), runtime: 'anthropic-owned', ...(input.effort ? { effort: input.effort } : {}) });

  /** The third layer's summary of what a compaction is about to drop, or
   *  undefined (disabled, nothing to drop, or the summarizer failed: the
   *  deterministic compaction then stands on its own). */
  const summarize = async (): Promise<string | undefined> => {
    if (input.semanticCompaction === false) return undefined;
    const start = tailStart(messages, tailBudget());
    if (start < 1) return undefined;
    try {
      const reply = await input.client.createTurn({
        model: SUMMARY_MODEL, maxTokens: 8_000, system: SUMMARY_INSTRUCTIONS, tools: [], thinkingBudget: 0,
        messages: [{ role: 'user', content: `Task:\n${input.goal}\n\nTranscript of the earlier turns:\n${transcriptForSummary(messages.slice(0, start))}` }],
      }, input.signal);
      const su = reply.usage;
      const summaryUsage = { inputTokens: su.input_tokens ?? 0, outputTokens: su.output_tokens ?? 0, cacheReadTokens: su.cache_read_input_tokens ?? 0, cacheCreationTokens: su.cache_creation_input_tokens ?? 0 };
      // Billed at the summarizer's own prices, counted in this dispatch.
      const summaryUsd = estimateCostUsd(summaryUsage, SUMMARY_MODEL);
      extraUsd += summaryUsd;
      flow.summaryUsd += summaryUsd;
      const text = textOf(reply);
      emit('owned.summary', { ok: text.length > 0, model: SUMMARY_MODEL, usage: su, summaryTokens: estimateTokens(text) });
      return text || undefined;
    } catch (err) {
      emit('owned.summary', { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
      return undefined;
    }
  };

  const doCompact = async (reason: 'window' | 'semantic' | 'priced' | 'recovery', precomputed?: CompactionResult): Promise<boolean> => {
    if (!precomputed && !canCompact(messages)) return false;
    const summary = precomputed ? undefined : await summarize();
    const result = precomputed ?? compact({ goal: input.goal, messages, activeState: stateForModel(), calls, tailBudget: tailBudget(), keepThinking, ...(summary ? { summary } : {}) });
    if (!result) return false;
    messages = result.messages;
    compactions++;
    flow.compactionDroppedTokens += result.droppedTokens;
    flow.compactionStateTokens += result.stateTokens;
    compactedBeforeTurn = true;
    appendedSince = result.keptTokens + result.stateTokens + estimateTokens(input.goal);
    lastContext = fixedTokens;
    // Every pointer information control could make into the old history is gone.
    void input.state.handle({ hook_event_name: 'PostCompact' }).catch(() => {});
    emit('owned.compaction', { reason, summarized: Boolean(summary), droppedCallIds: result.droppedCallIds, retainedCallIds: result.retainedCallIds, droppedTokens: result.droppedTokens, keptTokens: result.keptTokens, stateTokens: result.stateTokens });
    return true;
  };

  /** The placeholder a moved output is replaced by: where the whole of it is. */
  const placeholderFor = (id: string, tokens: number): string | null => {
    const o = outputs.get(id);
    if (!o) return null;
    const head = `${MOVED_MARK} (~${tokens} tokens) was moved out of the context to keep it small.`;
    if (o.fetched) return `${head} It was a FetchResult of ${o.fetched}; fetch it again if you need it.]`;
    // The output exactly as it was seen, one call away.
    if (o.resultUri && resultStore?.has(o.resultUri)) {
      return `${head} Full output: ${o.resultUri} — FetchResult it (offset/limit, or pattern)${o.filePath ? `, or Read ${o.filePath} again for its current content` : ''}.]`;
    }
    if (o.filePath) return `${head} It was a Read of ${o.filePath}; Read it again if you need it (the file may have changed since).]`;
    return `${head} The full output is saved at ${o.spilledTo ?? `${SPILL_DIR}/${id.replace(/[^A-Za-z0-9_-]/g, '')}.out`}; Read it (with offset/limit) if you need it.]`;
  };

  /** ToFu's second layer, priced: applied only when what it saves over the
   *  remaining turns beats rewriting the cache from the first edit on. */
  const pastTurns = () => input.pastTurns ?? input.state.pastTurns?.() ?? [];
  const doMicro = async (projected: number): Promise<void> => {
    const preview = microCompact({ messages, tailBudget: tailBudget(), placeholderFor, keepThinking });
    if (!preview) return;
    const price = priceCompaction({
      droppedTokens: preview.savedTokens, droppedCalls: preview.movedIds.length, keptTokens: preview.rewrittenTokens, stateTokens: 0,
      contextTokens: projected, outputPerTurn: usage.numTurns ? usage.outputTokens / usage.numTurns : 0,
      remainingTurns: expectedRemainingTurns(usage.numTurns, pastTurns()), refetchProbability: 0.5,
    }, prices);
    if (!price.worth) return;
    // Every placeholder must point at something real: save what is not saved yet.
    const failed = new Set<string>();
    for (const id of preview.movedIds) {
      const o = outputs.get(id)!;
      if (o.filePath || o.fetched || o.spilledTo || (o.resultUri && resultStore?.has(o.resultUri))) continue;
      const saved = await input.broker.saveOutput(id, o.raw);
      if (saved) o.spilledTo = saved; else failed.add(id);
    }
    const final = failed.size
      ? microCompact({ messages, tailBudget: tailBudget(), placeholderFor: (id, t) => (failed.has(id) ? null : placeholderFor(id, t)), keepThinking })
      : preview;
    if (!final) return;
    messages = final.messages;
    microCompactions++;
    flow.microSavedTokens += final.savedTokens;
    compactedBeforeTurn = true;
    lastContext = Math.max(fixedTokens, lastContext - final.savedTokens);
    void input.state.handle({ hook_event_name: 'PostCompact' }).catch(() => {});
    emit('owned.micro_compaction', { movedIds: final.movedIds, savedTokens: final.savedTokens, rewrittenTokens: final.rewrittenTokens, ...price });
  };

  const finish = (stop: StopKind, error?: ModelError): AgentSessionResult => {
    const succeeded = stop === 'end_turn';
    const context: ContextTelemetry = {
      ...flow, microCompactions, compactions, cacheReadTokens: usage.cacheReadTokens, cacheCreationTokens: usage.cacheCreationTokens,
      ...(resultStore ? { results: resultStore.stats() } : {}),
    };
    const message = stop === 'spend_limit' ? `Stopped: this run reached its $${(input.spendLimitUsd ?? 0).toFixed(2)} spend limit`
      : stop === 'max_turns' ? 'Stopped: reached the maximum number of turns'
      : stop === 'refusal' ? 'The model declined to continue (refusal)'
      : stop === 'aborted' ? 'Stopped: the dispatch timed out'
      : error ? `Model API error (${error.kind}): ${error.message}` : finalText;
    emit('result', {
      subtype: succeeded ? 'success' : stop === 'max_turns' ? 'error_max_turns' : 'error_during_execution',
      is_error: !succeeded, result: succeeded ? finalText : message, stop_reason: stop,
      num_turns: usage.numTurns, duration_ms: Date.now() - started, total_cost_usd: cost(), compactions, micro_compactions: microCompactions, context,
      usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cache_read_input_tokens: usage.cacheReadTokens, cache_creation_input_tokens: usage.cacheCreationTokens },
      ...(error ? { error_kind: error.kind } : {}),
    });
    return {
      stop, succeeded, finalText, events, usage: { ...usage }, costUsd: cost(), compactions, context, ...(error ? { error } : {}),
      transcript: { model, system, toolsJson, messages: [...messages] },
    };
  };

  for (;;) {
    if (input.signal?.aborted) return finish('aborted');
    if (usage.numTurns >= maxTurns) return finish('max_turns');
    if (input.spendLimitUsd !== undefined && cost() >= input.spendLimitUsd) return finish('spend_limit');

    // ToFu's three layers. The first (size-aware output budgets) is the
    // broker's. The third fires near the limit: a summary-led compaction at
    // 80% of the usable context, a deterministic one at 100% whatever the
    // price. Below that, the second moves cold bulky outputs when it pays.
    const projected = lastContext + appendedSince;
    const usable = window - maxTokens;
    if (projected > usable && canCompact(messages)) await doCompact('window');
    else if (input.semanticCompaction !== false && projected > SEMANTIC_SHARE * usable && canCompact(messages)) await doCompact('semantic');
    else if (input.microCompaction !== false && usage.numTurns > 0) await doMicro(projected);
    if (input.pricedCompaction === true && canCompact(messages) && usage.numTurns > 0 && !compactedBeforeTurn) {
      const preview = compact({ goal: input.goal, messages, activeState: stateForModel(), calls, tailBudget: tailBudget(), keepThinking });
      if (preview) {
        const price = priceCompaction({
          droppedTokens: preview.droppedTokens, droppedCalls: preview.droppedCallIds.length, keptTokens: preview.keptTokens, stateTokens: preview.stateTokens,
          contextTokens: projected, outputPerTurn: usage.outputTokens / usage.numTurns,
          remainingTurns: expectedRemainingTurns(usage.numTurns, pastTurns()), refetchProbability: 0.5,
        }, prices);
        if (price.worth) await doCompact('priced', preview);
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
      if (error.kind === 'bad_request' && !retriedAfterCompaction && await doCompact('recovery')) {
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
      const sized = (m: MessageParam) => estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      const opener = history.length ? sized(history[0]) : 0;
      emit('owned.turn', {
        turn: usage.numTurns, model, effort: input.effort ?? null, stopReason: message.stop_reason,
        usage: u, costUsd: estimateCostUsd({ inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheCreationTokens: u.cache_creation_input_tokens ?? 0 }, model),
        cumulativeCostUsd: cost(), compactedBefore: compactedBeforeTurn,
        layers: {
          systemTokens: estimateTokens(system), toolTokens: estimateTokens(JSON.stringify(tools)),
          historyTokens: history.reduce((s, m) => s + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 0),
          historyMessages: history.length,
        },
        // The request in cache zones: the fixed prefix (policy, contract,
        // tools), the opening message (goal, orientation, or the state a
        // compaction left), and the hot history every compaction acts on.
        zones: {
          stable: fixedTokens, semiStable: opener,
          hot: history.slice(1).reduce((s, m) => s + sized(m), 0),
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
          ...(outcome.resultRef ? { resultUri: outcome.resultRef.uri } : {}),
        });
        flow.toolRawTokens += estimateTokens(outcome.raw);
        flow.toolShownTokens += estimateTokens(outcome.content);
        if (call.name === 'FetchResult') {
          flow.fetches++;
          flow.fetchedTokens += estimateTokens(outcome.content);
        }
        const callInput = (call.input ?? {}) as Record<string, unknown>;
        outputs.set(call.id, {
          raw: outcome.raw, tool: call.name,
          ...(call.name === 'Read' && typeof callInput.file_path === 'string' ? { filePath: callInput.file_path } : {}),
          ...(call.name === 'FetchResult' && typeof callInput.ref === 'string' && !outcome.isError ? { fetched: callInput.ref } : {}),
          ...(outcome.spilledTo ? { spilledTo: outcome.spilledTo } : {}),
          ...(outcome.resultRef ? { resultUri: outcome.resultRef.uri } : {}),
        });
        decisions.push({ id: call.id, name: call.name, isError: outcome.isError, refusal: outcome.refusal ?? null, projected: outcome.projected, rawChars: outcome.raw.length, shownChars: outcome.content.length, ...(outcome.spilledTo ? { spilledTo: outcome.spilledTo } : {}), ...(outcome.resultRef ? { resultUri: outcome.resultRef.uri } : {}) });
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
      if (message.stop_reason === 'model_context_window_exceeded') await doCompact('window');
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
