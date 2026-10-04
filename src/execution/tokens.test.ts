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

describe('visibleContextProfile', () => {
  const turn = (id: string, input: number, cacheRead = 0, cacheWrite = 0, extra: Record<string, unknown> = {}): StructuredEvent =>
    ev({ type: 'assistant', message: { id, usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite } }, ...extra });

  it('reads what the model could see on each turn: input plus everything served or written from cache', async () => {
    const { visibleContextProfile } = await import('./tokens.js');
    const profile = visibleContextProfile([turn('a', 30, 20_000, 500), turn('b', 40, 21_000, 900), turn('c', 10, 22_000, 300)]);
    expect(profile.turns).toBe(3);
    expect(profile.first).toBe(20_530);
    expect(profile.last).toBe(22_310);
    expect(profile.peak).toBe(22_310);
    expect(profile.average).toBeCloseTo((20_530 + 21_940 + 22_310) / 3);
  });

  it('counts one API response once, however many events carried it, and skips subagents', async () => {
    const { visibleContextProfile } = await import('./tokens.js');
    const profile = visibleContextProfile([turn('a', 100, 1_000), turn('a', 100, 1_000), turn('s', 999_999, 0, 0, { parent_tool_use_id: 'x' })]);
    expect(profile.turns).toBe(1);
    expect(profile.peak).toBe(1_100);
  });

  it('notices when the runtime cleared or compacted its own history: a sharp fall in what the next turn sees', async () => {
    const { visibleContextProfile } = await import('./tokens.js');
    const profile = visibleContextProfile([turn('a', 10, 60_000), turn('b', 10, 90_000), turn('c', 10, 25_000), turn('d', 10, 27_000)]);
    expect(profile.reductions).toEqual([{ from: 90_010, to: 25_010, tokens: 65_000 }]);
    expect(profile.peak).toBe(90_010);
  });

  it('does not mistake ordinary variation for a compaction', async () => {
    const { visibleContextProfile } = await import('./tokens.js');
    expect(visibleContextProfile([turn('a', 10, 50_000), turn('b', 10, 45_000), turn('c', 10, 52_000)]).reductions).toEqual([]);
  });

  it('is all zeros, never a throw, for a stream with nothing in it', async () => {
    const { visibleContextProfile } = await import('./tokens.js');
    expect(visibleContextProfile([])).toEqual({ turns: 0, first: 0, last: 0, peak: 0, average: 0, reductions: [] });
  });
});
