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
  spilledTo?: string;
}

export interface CompactionInput {
  goal: string;
  messages: MessageParam[];
  /** The canonical task state, rendered. */
  activeState: string;
  /** Every tool call so far, by id. */
  calls: ReadonlyMap<string, CallRecord>;
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

/** Index of the assistant message that opens the last exchange, or -1 when
 *  there is nothing before it to drop. An exchange is an assistant turn and
 *  the user turn that answers it. */
function tailStart(messages: MessageParam[]): number {
  for (let i = messages.length - 1; i >= 1; i--) {
    if (messages[i].role === 'assistant') return i > 1 ? i : -1;
  }
  return -1;
}

export function canCompact(messages: MessageParam[]): boolean {
  return tailStart(messages) > 0;
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

export function compact(input: CompactionInput): CompactionResult | null {
  const start = tailStart(input.messages);
  if (start < 0) return null;
  const dropped = input.messages.slice(0, start);
  const tail = input.messages.slice(start).map((m): MessageParam => {
    if (m.role !== 'assistant' || typeof m.content === 'string') return m;
    const kept = (m.content as ContentBlock[]).filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
    return { role: 'assistant', content: (kept.length ? kept : [{ type: 'text', text: '(continuing)' }]) as MessageParam['content'] };
  });
  const droppedCallIds = toolUseIds(dropped);
  const index = droppedCallIds.map((id) => input.calls.get(id)).filter((c): c is CallRecord => c !== undefined)
    .map((c, i) => `${i + 1}. ${c.name} ${c.target}${c.isError ? ' — failed' : ''}${c.spilledTo ? ` — full output in ${c.spilledTo}` : ''}`);
  const state = [
    '[CherryOnTop: the earlier turns of this session were compacted to keep the context small. Nothing was lost: re-run or re-read anything you need again.]',
    input.activeState,
    ...(index.length ? [`Calls made before this point (${index.length}):\n${index.join('\n')}`] : []),
  ].join('\n\n');
  const messages: MessageParam[] = [{ role: 'user', content: `${input.goal}\n\n${state}` }, ...tail];
  return {
    messages,
    droppedCallIds,
    retainedCallIds: toolUseIds(tail),
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
