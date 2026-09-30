import type { StructuredEvent } from '../adapters/adapter.js';

export interface DispatchUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  numTurns: number;
}

// Exported for Task 4, which needs a shared zero-usage value to fall back to.
export const ZERO_USAGE: DispatchUsage = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 0,
};

function lastResultPayload(events: StructuredEvent[]): Record<string, unknown> | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type !== 'result') continue;
    const p = events[i].payload;
    return typeof p === 'object' && p !== null ? (p as Record<string, unknown>) : null;
  }
  return null;
}

/** Pulls token counts off Claude Code's final `result` event. The event also
 *  carries `total_cost_usd`, which the rest of the codebase already reads. Any
 *  shape we don't recognise yields zeros — never throws, never fails a run. */
/** Usage summed from per-step assistant messages, for a run that never
 *  emitted its final `result` (killed at a timeout, crashed). Each API response
 *  can arrive as several assistant events sharing one message id, so each id
 *  is counted once, and subagent messages (`parent_tool_use_id`) are skipped,
 *  per the Claude Code cost-tracking guidance. Output tokens here are the
 *  per-step placeholder, so this is a lower bound. Without it such a run
 *  reported ~$0 and the spend cap could not see it (measured: a run that spent
 *  ~$6 of input reported $0.09). */
export function recoveredUsage(events: StructuredEvent[]): { usage: DispatchUsage; model?: string } {
  const seen = new Set<string>();
  const usage = { ...ZERO_USAGE };
  let model: string | undefined;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  for (const event of events) {
    if (event.type !== 'assistant') continue;
    const p = event.payload as { parent_tool_use_id?: unknown; message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> } } | null;
    const id = p?.message?.id;
    if (p?.parent_tool_use_id || typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    const u = p?.message?.usage ?? {};
    usage.inputTokens += n(u.input_tokens);
    usage.outputTokens += n(u.output_tokens);
    usage.cacheReadTokens += n(u.cache_read_input_tokens);
    usage.cacheCreationTokens += n(u.cache_creation_input_tokens);
    usage.numTurns += 1;
    if (typeof p?.message?.model === 'string') model = p.message.model;
  }
  return { usage, ...(model ? { model } : {}) };
}

export interface VisibleContextProfile {
  turns: number;
  first: number;
  last: number;
  peak: number;
  average: number;
  /** Sharp falls in what the model could see from one turn to the next. */
  reductions: Array<{ from: number; to: number; tokens: number }>;
}

/** A turn that sees this fraction of the previous turn's context or less is
 *  read as the runtime having cleared or compacted its history. Ordinary
 *  turns only grow the prefix; a fall this large has no other cause. */
export const CONTEXT_REDUCTION_RATIO = 0.7;

/** How much context the model could see on each turn of a run, from the usage
 *  every assistant message already reports.
 *
 *  CherryOnTop does not own the conversation (the agent CLI does, inside the
 *  sandbox), so it cannot prune or compact it — but it can *watch* it. What a
 *  turn sees is input plus everything read from or written to the prompt cache;
 *  the peak is the context the run actually carried, and a sharp fall between two
 *  turns is the runtime compacting or clearing on its own, which is the
 *  provider-native mechanism this system defers to. Measured rather than
 *  assumed, so a benchmark can say how big the context got and whether the
 *  runtime shrank it. Total. */
export function visibleContextProfile(events: StructuredEvent[]): VisibleContextProfile {
  const seen = new Set<string>();
  const sizes: number[] = [];
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  for (const event of events) {
    if (event.type !== 'assistant') continue;
    const p = event.payload as { parent_tool_use_id?: unknown; message?: { id?: unknown; usage?: Record<string, unknown> } } | null;
    const id = p?.message?.id;
    if (p?.parent_tool_use_id || typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    const u = p?.message?.usage ?? {};
    sizes.push(n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens));
  }
  const reductions: VisibleContextProfile['reductions'] = [];
  for (let i = 1; i < sizes.length; i++) {
    if (sizes[i] <= sizes[i - 1] * CONTEXT_REDUCTION_RATIO) {
      reductions.push({ from: sizes[i - 1], to: sizes[i], tokens: sizes[i - 1] - sizes[i] });
    }
  }
  return {
    turns: sizes.length,
    first: sizes[0] ?? 0,
    last: sizes.at(-1) ?? 0,
    peak: sizes.length ? Math.max(...sizes) : 0,
    average: sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0,
    reductions,
  };
}

export function usageFromEvents(events: StructuredEvent[]): DispatchUsage {
  const payload = lastResultPayload(events);
  if (!payload) return recoveredUsage(events).usage;
  const u = (payload.usage ?? {}) as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    inputTokens: n(u.input_tokens),
    outputTokens: n(u.output_tokens),
    cacheReadTokens: n(u.cache_read_input_tokens),
    cacheCreationTokens: n(u.cache_creation_input_tokens),
    numTurns: n(payload.num_turns),
  };
}

// Matched against the runtime's own final error text. Deliberately broad on
// phrasing and narrow on intent: only a *model* rejection should trigger the
// one-shot retry without --model. A timeout or auth error must not.
// The rejection phrase can land on either side of the word "model" ("model
// ... not available" vs. "do not have access ... to this model"), so both
// orderings are matched.
const MODEL_REJECTION =
  /\bmodel\b[^.]*\b(not available|no access|not found|invalid|unknown|unsupported|do not have access)\b|\b(not available|no access|not found|invalid|unknown|unsupported|do not have access)\b[^.]*\bmodel\b|\b(invalid|unknown) model\b|not available on your (plan|subscription)/i;

export function shouldRetryWithoutModel(events: StructuredEvent[]): boolean {
  const payload = lastResultPayload(events);
  if (!payload || payload.is_error !== true) return false;
  const text = typeof payload.result === 'string' ? payload.result : String(payload.subtype ?? '');
  return MODEL_REJECTION.test(text);
}
