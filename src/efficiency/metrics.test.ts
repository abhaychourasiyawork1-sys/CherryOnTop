import { describe, it, expect } from 'vitest';
import { buildEfficiencyRecord, EMPTY_TOTALS } from './metrics.js';

const base = {
  taskId: 'task-1',
  outcome: 'success' as const,
  inputTokens: 1000,
  outputTokens: 400,
  cachedTokens: 0,
  coordinationTokens: 100,
  recoveryTokens: 0,
  planningCalls: 1,
  executionCalls: 1,
  synthesisCalls: 0,
  avoidedPlanningCalls: 0,
  avoidedSynthesisCalls: 1,
  avoidedExecutionCalls: 0,
  tokensAvoided: 0,
  retries: 0,
  queueMs: 50,
  dispatchMs: 2500,
  endToEndMs: 4100,
  costUsd: 0.02,
  qualityScore: 0.95,
};

describe('buildEfficiencyRecord', () => {
  // The point of the whole exercise is work that did not happen, and an absence
  // is not measurable by looking at what did. A reused result is the only place
  // the system can say "these tokens were not spent" with a number behind it.
  it('reports the share of dispatches that never happened', () => {
    expect(buildEfficiencyRecord(base).workAvoidedRatio).toBeCloseTo(1 / 3);
    expect(buildEfficiencyRecord({ ...base, avoidedSynthesisCalls: 0 }).workAvoidedRatio).toBe(0);
    expect(buildEfficiencyRecord({
      ...base, planningCalls: 0, executionCalls: 0, synthesisCalls: 0,
      avoidedSynthesisCalls: 0, avoidedPlanningCalls: 0, avoidedExecutionCalls: 0,
    }).workAvoidedRatio).toBe(0);
  });

  it('carries avoided tokens without adding them to what was spent', () => {
    const record = buildEfficiencyRecord({ ...base, tokensAvoided: 900_000 });
    expect(record.tokensAvoided).toBe(900_000);
    // Avoided tokens are a counterfactual, not a bill. Adding them to the total
    // would make every cache hit look like a cost.
    expect(record.totalTokens).toBe(1400);
  });

  it('builds a successful-task record', () => {
    const record = buildEfficiencyRecord(base);
    expect(record.totalTokens).toBe(1400);
    expect(record.tokensPerSuccessfulTask).toBe(1400);
    expect(record.outcome).toBe('success');
    expect(record.modelCalls).toBe(2);
  });

  it('counts cached tokens as a slice of input, not as extra spend', () => {
    const record = buildEfficiencyRecord({ ...base, cachedTokens: 900 });
    // 900 of the 1000 input tokens were cache reads. Adding them again would
    // report 2300 tokens for a run that consumed 1400.
    expect(record.totalTokens).toBe(1400);
    expect(record.cacheHitRatio).toBeCloseTo(0.9);
  });

  it('does not double-count coordination tokens', () => {
    // coordinationTokens is the plan+synthesize slice of input+output, not a
    // separate pool. It reports share, it does not add to the total.
    const record = buildEfficiencyRecord({ ...base, coordinationTokens: 700 });
    expect(record.totalTokens).toBe(1400);
    expect(record.coordinationTokenShare).toBeCloseTo(0.5);
  });

  it('reports no tokens-per-successful-task for an unsuccessful run', () => {
    for (const outcome of ['failure', 'partial', 'budget_exhausted'] as const) {
      expect(buildEfficiencyRecord({ ...base, outcome }).tokensPerSuccessfulTask).toBeNull();
    }
  });

  it('reports the share of synthesis calls that were avoided', () => {
    expect(buildEfficiencyRecord(base).synthesisAvoidanceRatio).toBe(1);
    expect(buildEfficiencyRecord({ ...base, synthesisCalls: 1, avoidedSynthesisCalls: 1 })
      .synthesisAvoidanceRatio).toBe(0.5);
    expect(buildEfficiencyRecord({ ...base, synthesisCalls: 0, avoidedSynthesisCalls: 0 })
      .synthesisAvoidanceRatio).toBe(0);
  });

  it('never divides by zero on an empty run', () => {
    const record = buildEfficiencyRecord({ ...base, ...EMPTY_TOTALS, outcome: 'failure' });
    expect(record.totalTokens).toBe(0);
    expect(record.cacheHitRatio).toBe(0);
    expect(record.coordinationTokenShare).toBe(0);
    expect(record.recoveryTokenShare).toBe(0);
    expect(Number.isFinite(record.tokensPerModelCall)).toBe(true);
  });

  it('reports recovery spend as a share of the total', () => {
    const record = buildEfficiencyRecord({ ...base, recoveryTokens: 350, retries: 1 });
    expect(record.recoveryTokenShare).toBeCloseTo(0.25);
  });
});
