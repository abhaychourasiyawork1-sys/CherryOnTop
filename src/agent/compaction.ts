/** Compaction as a CherryOnTop operation: when, priced; how, deterministic.
 *
 *  When. Every token in the history is re-read (from cache) on every later
 *  turn, so dropping `d` tokens saves `d · p_read · R` over the R turns left.
 *  Rebuilding the request costs a cache write of what is kept plus the state
 *  that replaces what was dropped, and dropping risks a refetch: the agent
 *  comes back for something that left the context. Compact exactly when the
 *  saving beats both — the same carrying-cost arithmetic information control
 *  prices a single observation with (economics.ts), applied to the history.
 *  Independently, a request that could not fit the model's window is compacted
 *  whatever the price: that is a hard limit, not a trade.
 *
 *  How. The new history is the goal plus a state block built from the
 *  session's own trajectory (information control's active state: edited files,
 *  verification status, last failure, searches that found nothing) and an
 *  index of every dropped call with its outcome and, where its output was
 *  saved, its locator — then the most recent exchange verbatim, because the
 *  model has not yet seen the result of its last call any other way.
 *
 *  Thinking blocks are stripped from the retained exchange: on models with
 *  preserved thinking a block replayed after the history before it changed is
 *  a 400 (keep-tail compaction is exactly that case), and text and tool calls
 *  are all a retained turn needs. No model call is made to summarize. */
import { estimateTokens } from '../context/candidates.js';
import { refetchUsd, type Prices } from '../infocontrol/economics.js';
import type { ContentBlock, MessageParam } from './model-client.js';

export interface CallRecord {
  id: string;
  name: string;
  /** What the call was about (a command, a path, a pattern). */
  target: string;
  isError: boolean;
  /** The first line of what a failed call returned: errors are what an agent
   *  most needs not to rediscover (HarnessBridge keeps them; so does this). */
  error?: string;
  spilledTo?: string;
}

export interface CompactionInput {
  goal: string;
  messages: MessageParam[];
  /** The canonical task state, rendered. */
  activeState: string;
  /** Every tool call of the session so far, in order — including calls an
   *  earlier compaction already folded away, so the index carries forward. */
  calls: ReadonlyMap<string, CallRecord>;
  /** Tokens the verbatim tail may hold; at least the last exchange is always kept. */
  tailBudget?: number;
  /** Keep thinking blocks in the retained tail (budget-thinking models, which
   *  require them on the in-flight tool round and run no history-binding check). */
  keepThinking?: boolean;
  /** A summary of the dropped turns written by a lightweight model (ToFu's
   *  third layer). Absent, the call index alone stands for them. */
  summary?: string;
}

export interface CompactionResult {
  messages: MessageParam[];
  /** Ids of the tool calls whose exchanges left the context. */
  droppedCallIds: string[];
  /** Ids of the tool calls still shown verbatim. */
  retainedCallIds: string[];
  droppedTokens: number;
  keptTokens: number;
  stateTokens: number;
}

/** Most exchanges kept verbatim (the Harness Effect keeps a live tail of
 *  4–12 messages); the token budget usually binds first. */
export const MAX_TAIL_EXCHANGES = 6;
/** Index entries kept; older ones are counted, not listed. */
const MAX_INDEX = 60;

/** Indexes of the assistant messages that open each exchange (an assistant
 *  turn and the user turn answering it), oldest first, excluding the opening
 *  user message. */
function exchangeStarts(messages: MessageParam[]): number[] {
  const starts: number[] = [];
  for (let i = 1; i < messages.length; i++) if (messages[i].role === 'assistant') starts.push(i);
  return starts;
}

export function canCompact(messages: MessageParam[]): boolean {
  return exchangeStarts(messages).length > 1;
}

function tokensOf(messages: MessageParam[]): number {
  return messages.reduce((s, m) => s + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 0);
}

function toolUseIds(messages: MessageParam[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const b of m.content) if (b.type === 'tool_use') ids.push(b.id);
  }
  return ids;
}

/** Where the verbatim tail starts: the last exchange always, then earlier ones
 *  while they fit the budget, never all of them (something must be dropped). */
export function tailStart(messages: MessageParam[], budget: number): number {
  const starts = exchangeStarts(messages);
  if (starts.length < 2) return -1;
  let start = starts.at(-1)!;
  for (let k = starts.length - 2, kept = 1; k >= 1 && kept < MAX_TAIL_EXCHANGES; k--, kept++) {
    if (tokensOf(messages.slice(starts[k])) > budget) break;
    start = starts[k];
  }
  return start;
}

export function compact(input: CompactionInput): CompactionResult | null {
  const start = tailStart(input.messages, input.tailBudget ?? 0);
  if (start < 0) return null;
  const dropped = input.messages.slice(0, start);
  const tail = input.messages.slice(start).map((m): MessageParam => {
    if (m.role !== 'assistant' || typeof m.content === 'string' || input.keepThinking) return m;
    const kept = (m.content as ContentBlock[]).filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
    return { role: 'assistant', content: (kept.length ? kept : [{ type: 'text', text: '(continuing)' }]) as MessageParam['content'] };
  });
  const retainedCallIds = toolUseIds(tail);
  const retained = new Set(retainedCallIds);
  const folded = [...input.calls.values()].filter((c) => !retained.has(c.id));
  const listed = folded.slice(-MAX_INDEX);
  const index = listed.map((c, i) => `${folded.length - listed.length + i + 1}. ${c.name} ${c.target}`
    + `${c.isError ? ` — failed${c.error ? `: ${c.error}` : ''}` : ''}${c.spilledTo ? ` — full output in ${c.spilledTo}` : ''}`);
  const state = [
    '[CherryOnTop: the earlier turns of this session were compacted to keep the context small. Nothing was lost: re-run or re-read anything you need again.]',
    input.activeState,
    ...(input.summary ? [`Summary of the earlier work (written for this task, exact values kept):\n${input.summary.trim()}`] : []),
    ...(index.length ? [`Calls made before this point (${folded.length}${folded.length > listed.length ? `, the last ${listed.length} listed` : ''}):\n${index.join('\n')}`] : []),
  ].join('\n\n');
  const messages: MessageParam[] = [{ role: 'user', content: `${input.goal}\n\n${state}` }, ...tail];
  return {
    messages,
    droppedCallIds: toolUseIds(dropped),
    retainedCallIds,
    droppedTokens: tokensOf(dropped),
    keptTokens: tokensOf(tail),
    stateTokens: estimateTokens(state),
  };
}

export interface CompactionPrice {
  savedUsd: number;
  costUsd: number;
  /** The saving beats the rebuild plus the refetch risk. */
  worth: boolean;
}

/** Whether compacting now pays, from the session's own numbers.
 *
 *  Each dropped call is treated as independently wanted again with
 *  probability `refetchProbability` (with no evidence, the uniform prior's
 *  mean, ½), and a refetch costs what information control prices one at: a
 *  turn that re-reads the context, plus carrying what it brought back. */
export function priceCompaction(input: {
  droppedTokens: number;
  droppedCalls: number;
  keptTokens: number;
  stateTokens: number;
  contextTokens: number;
  outputPerTurn: number;
  remainingTurns: number;
  refetchProbability: number;
}, prices: Prices): CompactionPrice {
  const savedUsd = Math.max(0, input.droppedTokens - input.stateTokens) * prices.read * Math.max(0, input.remainingTurns);
  const rebuildUsd = (input.keptTokens + input.stateTokens) * prices.write;
  const calls = Math.max(1, input.droppedCalls);
  const riskUsd = calls * input.refetchProbability * refetchUsd({
    contextTokens: Math.max(0, input.contextTokens - input.droppedTokens), outputPerTurn: input.outputPerTurn,
    sliceTokens: input.droppedTokens / calls, remainingTurns: input.remainingTurns,
  }, prices);
  const costUsd = rebuildUsd + riskUsd;
  return { savedUsd, costUsd, worth: savedUsd > costUsd };
}

/** Marks a tool output that micro-compaction has already moved out. */
export const MOVED_MARK = '[CherryOnTop: this output';

export interface MicroCompactionInput {
  messages: MessageParam[];
  /** Tokens the verbatim hot tail may hold (the same tail full compaction keeps). */
  tailBudget: number;
  /** The placeholder for one moved output, naming where the whole of it is;
   *  null when it cannot be recovered and so must stay. */
  placeholderFor(toolUseId: string, tokens: number): string | null;
  keepThinking: boolean;
}

export interface MicroCompactionResult {
  messages: MessageParam[];
  movedIds: string[];
  /** Tokens the moved outputs no longer carry, net of their placeholders. */
  savedTokens: number;
  /** Tokens from the first edited message to the end: what the cache rewrites. */
  rewrittenTokens: number;
}

/** ToFu's second layer: cache-aware micro-compaction of cold history, with no
 *  model call. Outputs of tool calls older than the hot tail that are larger
 *  than a pointer to them become that pointer (a saved file, the file itself,
 *  or the call to re-run). Every call, all reasoning, every error result and
 *  the hot tail stay verbatim, so the agent still sees everything it did and
 *  why; only bulky evidence it can fetch again leaves the context.
 *
 *  An edit is a prefix change: on models that bind thinking to the prefix,
 *  thinking after the first edited message is stripped, as in full compaction. */
export function microCompact(input: MicroCompactionInput): MicroCompactionResult | null {
  const start = tailStart(input.messages, input.tailBudget);
  if (start < 0) return null;
  const movedIds: string[] = [];
  let saved = 0;
  let firstEdited = -1;
  const messages = input.messages.map((m, i): MessageParam => {
    if (i >= start || m.role !== 'user' || typeof m.content === 'string') return m;
    let changed = false;
    const content = m.content.map((b) => {
      if (b.type !== 'tool_result' || b.is_error || typeof b.content !== 'string' || b.content.startsWith(MOVED_MARK)) return b;
      const tokens = estimateTokens(b.content);
      const placeholder = input.placeholderFor(b.tool_use_id, tokens);
      if (!placeholder || estimateTokens(placeholder) >= tokens) return b;
      changed = true;
      movedIds.push(b.tool_use_id);
      saved += tokens - estimateTokens(placeholder);
      return { ...b, content: placeholder };
    });
    if (!changed) return m;
    if (firstEdited < 0) firstEdited = i;
    return { ...m, content };
  });
  if (firstEdited < 0) return null;
  if (!input.keepThinking) {
    for (let i = firstEdited + 1; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== 'assistant' || typeof m.content === 'string') continue;
      const kept = (m.content as ContentBlock[]).filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
      messages[i] = { role: 'assistant', content: (kept.length ? kept : [{ type: 'text', text: '(continuing)' }]) as MessageParam['content'] };
    }
  }
  return { messages, movedIds, savedTokens: saved, rewrittenTokens: tokensOf(messages.slice(firstEdited)) };
}

/** What a lightweight model is asked when the context nears its limit (ToFu's
 *  third layer, with HarnessBridge's rules for what a summary must keep). */
export const SUMMARY_INSTRUCTIONS = `You compress the earlier part of a software agent's working session so it can continue without it. You are given the task and a transcript of the agent's earlier turns (its notes, the tool calls it made, and what they returned, shortened).

Write a working-state summary, judged against the task:
- Keep critical turns in full fidelity: exact file paths, commands, function and variable names, error messages, numbers, values and decisions. Never paraphrase these.
- Compress useful turns to what was tried, what resulted, and whether it advanced the task.
- Mention tangential turns in a few words; leave out irrelevant ones.
- Say plainly what was verified, what failed and why, and what is still open.

Use these sections: Progress so far / Key facts and values / What failed and why / Open items and next steps. Output only the summary.`;

/** The dropped turns as text for the summarizer: notes, calls, and each
 *  result shortened, bounded overall so the summary request always fits. */
export function transcriptForSummary(messages: MessageParam[], perResult = 2_000, total = 300_000): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') { lines.push(`${m.role === 'user' ? 'USER' : 'AGENT'}: ${m.content.slice(0, perResult * 2)}`); continue; }
    for (const b of m.content as unknown as Array<Record<string, unknown>>) {
      if (b.type === 'text') lines.push(`${m.role === 'user' ? 'NOTE' : 'AGENT'}: ${String(b.text)}`);
      else if (b.type === 'tool_use') lines.push(`CALL ${String(b.name)} ${JSON.stringify(b.input).slice(0, 400)}`);
      else if (b.type === 'tool_result') {
        const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        lines.push(`RESULT${b.is_error ? ' (error)' : ''}: ${c.length > perResult ? `${c.slice(0, perResult / 2)}\n…\n${c.slice(-perResult / 2)}` : c}`);
      }
    }
  }
  const text = lines.join('\n');
  return text.length > total ? `…(earliest turns omitted)…\n${text.slice(-total)}` : text;
}
