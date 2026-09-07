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
export function usageFromEvents(events: StructuredEvent[]): DispatchUsage {
  const payload = lastResultPayload(events);
  if (!payload) return { ...ZERO_USAGE };
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
