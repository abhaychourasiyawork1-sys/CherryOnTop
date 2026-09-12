import { describe, it, expect } from 'vitest';
import { routeProvider, fallbackProvider, type ProviderCapability } from './provider-router.js';
import type { RuntimeStat } from '../db/queries/memory.js';

const provider = (over: Partial<ProviderCapability> = {}): ProviderCapability => ({
  provider: 'claude-code', models: null, health: 'healthy', ...over,
});

const stat = (runtime: string, over: Partial<RuntimeStat> = {}): RuntimeStat => ({
  runtime, runs: 10, successRate: 0.9, avgCostUsd: 1, avgLatencyMs: 1000, ...over,
});

describe('provider choice is downstream of model choice', () => {
  it('never revises the model', () => {
    // Folding the two together is how a provider outage silently becomes a
    // quality decision.
    const decision = routeProvider({
      model: 'sonnet',
      candidates: [provider({ provider: 'codex', models: ['gpt-5'] })],
      stats: [],
    });
    expect(decision.provider).toBeNull();
    expect(decision.reason).toMatch(/no healthy provider can serve sonnet/);
    // ...and says exactly why, rather than quietly serving something else.
    expect(decision.rejected).toEqual([{ provider: 'codex', reason: 'cannot serve sonnet' }]);
  });

  it('rules out a provider that cannot serve the chosen model before scoring anything', () => {
    const decision = routeProvider({
      model: 'sonnet',
      candidates: [
        provider({ provider: 'codex', models: ['gpt-5'] }),
        provider({ provider: 'claude-code', models: ['sonnet', 'haiku'] }),
      ],
      stats: [stat('codex', { successRate: 1, avgCostUsd: 0.01 }), stat('claude-code')],
    });
    // Codex is cheaper and more reliable and is still not an option.
    expect(decision.provider).toBe('claude-code');
  });
});

describe('health', () => {
  it('refuses a provider that is down or rate limited', () => {
    const decision = routeProvider({
      model: undefined,
      candidates: [provider({ provider: 'a', health: 'down' }), provider({ provider: 'b', health: 'rate_limited' })],
      stats: [],
    });
    expect(decision.provider).toBeNull();
    expect(decision.rejected.map((r) => r.reason)).toEqual(['reported down', 'rate limited']);
  });

  it('prefers healthy to degraded before cost or latency gets a vote', () => {
    // Degraded means it is working badly, and no saving makes that a good trade.
    const decision = routeProvider({
      model: undefined,
      candidates: [provider({ provider: 'cheap', health: 'degraded' }), provider({ provider: 'ok', health: 'healthy' })],
      stats: [stat('cheap', { avgCostUsd: 0.01, successRate: 1 }), stat('ok', { avgCostUsd: 10, successRate: 0.9 })],
    });
    expect(decision.provider).toBe('ok');
    expect(decision.rejected).toContainEqual({ provider: 'cheap', reason: 'degraded, and a healthy provider was available' });
  });

  it('uses a degraded provider rather than nothing', () => {
    const decision = routeProvider({
      model: undefined, candidates: [provider({ provider: 'only', health: 'degraded' })], stats: [],
    });
    expect(decision.provider).toBe('only');
  });
});

describe('the fast path', () => {
  it('does not score a single viable candidate', () => {
    // Scoring it would produce a breakdown implying a comparison nobody made.
    const decision = routeProvider({ model: undefined, candidates: [provider()], stats: [] });
    expect(decision.fastPath).toBe(true);
    expect(decision.breakdown).toBeUndefined();
    expect(decision.reason).toMatch(/only healthy provider/);
  });

  it('falls back to the default when nothing has enough history', () => {
    const decision = routeProvider({
      model: undefined,
      candidates: [provider({ provider: 'claude-code' }), provider({ provider: 'codex' })],
      stats: [],
    });
    expect(decision.provider).toBe('claude-code');
    expect(decision.fastPath).toBe(true);
  });

  it('scores when there is real history to score', () => {
    const decision = routeProvider({
      model: undefined,
      candidates: [provider({ provider: 'claude-code' }), provider({ provider: 'codex' })],
      stats: [stat('claude-code', { successRate: 0.5 }), stat('codex', { successRate: 1 })],
    });
    expect(decision.provider).toBe('codex');
    expect(decision.fastPath).toBe(false);
    expect(decision.breakdown?.alternativesConsidered).toBe(2);
  });
});

describe('falling back after a failure', () => {
  it('excludes the failed provider rather than re-scoring it', () => {
    // Whatever its history says, it just failed.
    const decision = fallbackProvider({
      model: undefined,
      candidates: [provider({ provider: 'claude-code' }), provider({ provider: 'codex' })],
      stats: [stat('claude-code', { successRate: 1 }), stat('codex', { successRate: 0.6 })],
      failed: 'claude-code', failure: 'rate_limited',
    });
    expect(decision.provider).toBe('codex');
    expect(decision.reason).toMatch(/claude-code is rate limited; falling back to codex/);
    expect(decision.rejected).toContainEqual({ provider: 'claude-code', reason: 'just failed (rate_limited)' });
  });

  it('says plainly when there is nowhere left to go', () => {
    const decision = fallbackProvider({
      model: undefined, candidates: [provider({ provider: 'claude-code' })],
      stats: [], failed: 'claude-code', failure: 'down',
    });
    expect(decision.provider).toBeNull();
    expect(decision.reason).toMatch(/nothing else can serve this/);
  });
});
