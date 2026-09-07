import { describe, it, expect } from 'vitest';
import { usageFromEvents, shouldRetryWithoutModel } from './tokens.js';
import type { StructuredEvent } from '../adapters/adapter.js';

const ev = (payload: unknown): StructuredEvent => ({ type: String((payload as { type?: unknown }).type ?? 'x'), payload });

describe('usageFromEvents', () => {
  it('reads the usage block off the final result event', () => {
    const events = [
      ev({ type: 'assistant' }),
      ev({
        type: 'result',
        total_cost_usd: 0.03,
        num_turns: 7,
        usage: {
          input_tokens: 1200,
          output_tokens: 340,
          cache_read_input_tokens: 8000,
          cache_creation_input_tokens: 500,
        },
      }),
    ];
    expect(usageFromEvents(events)).toEqual({
      inputTokens: 1200, outputTokens: 340, cacheReadTokens: 8000,
      cacheCreationTokens: 500, numTurns: 7,
    });
  });

  it('returns all zeros when there is no result event or no usage block', () => {
    expect(usageFromEvents([ev({ type: 'assistant' })])).toEqual({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 0,
    });
    expect(usageFromEvents([ev({ type: 'result', total_cost_usd: 0.01 })]).inputTokens).toBe(0);
  });

  it('uses the last result event when several are present', () => {
    const events = [
      ev({ type: 'result', usage: { input_tokens: 1 } }),
      ev({ type: 'result', usage: { input_tokens: 999 } }),
    ];
    expect(usageFromEvents(events).inputTokens).toBe(999);
  });
});

describe('shouldRetryWithoutModel', () => {
  const errResult = (text: string): StructuredEvent =>
    ({ type: 'result', payload: { type: 'result', is_error: true, result: text } });

  it('is true when the runtime rejected the requested model', () => {
    expect(shouldRetryWithoutModel([errResult('model "haiku" is not available on your plan')])).toBe(true);
    expect(shouldRetryWithoutModel([errResult('Invalid model name: haiku')])).toBe(true);
    expect(shouldRetryWithoutModel([errResult('You do not have access to this model')])).toBe(true);
  });

  it('is false for any other error or a clean run', () => {
    expect(shouldRetryWithoutModel([errResult('Request timed out')])).toBe(false);
    expect(shouldRetryWithoutModel([{ type: 'result', payload: { type: 'result', is_error: false } }])).toBe(false);
    expect(shouldRetryWithoutModel([])).toBe(false);
  });
});
