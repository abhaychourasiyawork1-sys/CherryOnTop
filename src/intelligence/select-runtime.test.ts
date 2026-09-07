import { describe, it, expect } from 'vitest';
import { selectRuntime } from './select-runtime.js';
import type { RuntimeStat } from '../db/queries/memory.js';

const stat = (over: Partial<RuntimeStat> & { runtime: string }): RuntimeStat => ({
  runs: 10, successRate: 0.9, avgCostUsd: 1, avgLatencyMs: 60_000, ...over,
});

describe('selectRuntime', () => {
  it('falls back to the default and says why when nothing has enough history', () => {
    const result = selectRuntime({
      available: ['claude-code', 'codex'],
      stats: [stat({ runtime: 'codex', runs: 2 })],
    });
    expect(result.runtime).toBe('claude-code');
    expect(result.breakdown.reason_insufficient_history).toBe(1);
  });

  it('prefers the runtime that succeeds more often', () => {
    const result = selectRuntime({
      available: ['claude-code', 'codex'],
      stats: [
        stat({ runtime: 'claude-code', successRate: 0.7 }),
        stat({ runtime: 'codex', successRate: 0.95 }),
      ],
    });
    expect(result.runtime).toBe('codex');
    expect(result.breakdown.successRate).toBeCloseTo(0.95, 5);
  });

  it('lets a cheap, fast runtime win a close call on success rate', () => {
    const result = selectRuntime({
      available: ['claude-code', 'codex'],
      stats: [
        stat({ runtime: 'claude-code', successRate: 0.91, avgCostUsd: 1.82, avgLatencyMs: 840_000 }),
        stat({ runtime: 'codex', successRate: 0.86, avgCostUsd: 1.41, avgLatencyMs: 660_000 }),
      ],
    });
    expect(result.runtime).toBe('codex');
  });

  it('does not let cost outweigh a large gap in success rate', () => {
    const result = selectRuntime({
      available: ['claude-code', 'codex'],
      stats: [
        stat({ runtime: 'claude-code', successRate: 0.95, avgCostUsd: 2 }),
        stat({ runtime: 'codex', successRate: 0.4, avgCostUsd: 0.5 }),
      ],
    });
    expect(result.runtime).toBe('claude-code');
  });

  it('never picks a runtime this deployment cannot dispatch to', () => {
    const result = selectRuntime({
      available: ['claude-code'],
      stats: [stat({ runtime: 'codex', successRate: 1 }), stat({ runtime: 'claude-code', successRate: 0.2 })],
    });
    expect(result.runtime).toBe('claude-code');
  });

  it('breaks a tie toward the more-observed runtime', () => {
    const result = selectRuntime({
      available: ['claude-code', 'codex'],
      stats: [
        stat({ runtime: 'codex', runs: 4 }),
        stat({ runtime: 'claude-code', runs: 40 }),
      ],
    });
    expect(result.runtime).toBe('claude-code');
  });

  it('shows its working, so the choice is inspectable', () => {
    const result = selectRuntime({
      available: ['claude-code', 'codex'],
      stats: [stat({ runtime: 'codex' }), stat({ runtime: 'claude-code', successRate: 0.5 })],
    });
    expect(Object.keys(result.breakdown)).toEqual(
      expect.arrayContaining(['successRate', 'costPenalty', 'latencyPenalty', 'score', 'runs']),
    );
    expect(result.breakdown.alternativesConsidered).toBe(2);
  });
});
