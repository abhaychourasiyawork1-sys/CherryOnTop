import { describe, it, expect } from 'vitest';
import { estimateCostUsd } from './pricing.js';
import { recoveredUsage, usageFromEvents } from './tokens.js';
import type { StructuredEvent } from '../adapters/adapter.js';

const step = (id: string, u: Record<string, number>, extra: Record<string, unknown> = {}): StructuredEvent => ({
  type: 'assistant',
  payload: { type: 'assistant', ...extra, message: { id, model: 'claude-sonnet-5', usage: u } },
});

describe('spend of a run that never reported a final result', () => {
  it('recovers usage from per-step messages, counting each API response once', () => {
    const events = [
      step('m1', { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 5 }),
      step('m1', { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 5 }),
      step('m2', { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, output_tokens: 7 }),
      step('s1', { input_tokens: 999, output_tokens: 999 }, { parent_tool_use_id: 't' }),
    ];
    expect(usageFromEvents(events)).toEqual({ inputTokens: 30, outputTokens: 12, cacheReadTokens: 5000, cacheCreationTokens: 1000, numTurns: 2 });
    expect(recoveredUsage(events).model).toBe('claude-sonnet-5');
  });

  it('prices it at list rates instead of reading it as free', () => {
    // Sonnet 5: $2 in, $10 out, cache write 1.25x, cache read 0.1x.
    const cost = estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 10_000_000, cacheCreationTokens: 1_000_000 }, 'claude-sonnet-5');
    expect(cost).toBeCloseTo(2 + 1 + 2 + 2.5, 6);
    expect(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, 'claude-haiku-4-5-20251001')).toBeCloseTo(1, 6);
    expect(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, undefined)).toBeGreaterThan(0);
  });

  it('still prefers the runtime\'s own final result when there is one', () => {
    const events: StructuredEvent[] = [
      step('m1', { input_tokens: 10, output_tokens: 5 }),
      { type: 'result', payload: { usage: { input_tokens: 42, output_tokens: 7 }, num_turns: 3 } },
    ];
    expect(usageFromEvents(events)).toMatchObject({ inputTokens: 42, outputTokens: 7, numTurns: 3 });
  });
});
