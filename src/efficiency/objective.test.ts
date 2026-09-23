import { describe, it, expect } from 'vitest';
import { summarizeRun, objectiveScore, evaluateExperiment, DEFAULT_WEIGHTS } from './objective.js';
import { buildEfficiencyRecord, EMPTY_TOTALS, EMPTY_ATTRIBUTION, type EfficiencyOutcome } from './metrics.js';

const record = (over: Partial<Parameters<typeof buildEfficiencyRecord>[0]> = {}) => buildEfficiencyRecord({
  taskId: 't', outcome: 'success' as EfficiencyOutcome, ...EMPTY_TOTALS, ...EMPTY_ATTRIBUTION,
  inputTokens: 1000, outputTokens: 200, endToEndMs: 10_000, qualityScore: 0.9, ...over,
});

const suite = (over: Partial<ReturnType<typeof summarizeRun>> = {}) => ({
  tasks: 10, successRate: 0.95, qualityScore: 0.9,
  tokensPerSuccessfulTask: 10_000, p50LatencyMs: 50_000, p95LatencyMs: 100_000,
  costPerSuccessfulTask: 0.5, turnsPerSuccessfulTask: 12,
  cacheReadPerSuccessfulTask: 80_000, explorationRatio: 0.4, optimizationRoi: 0,
  contextTokensPerTask: 1200, contextSelectionRatio: 0.1, tasksStopped: 0,
  cacheHitRatio: 0, coordinationTokenShare: 0.2, recoveryTokenShare: 0,
  synthesisAvoidanceRatio: 0, concurrencyEfficiency: 1,
  tokensAvoided: 0, workAvoidedRatio: 0, executionOverheadRatio: 0, ...over,
});

describe('summarizeRun', () => {
  it('sums avoided tokens across the run and averages the avoided-work share', () => {
    const summary = summarizeRun([
      record({ tokensAvoided: 1000, avoidedExecutionCalls: 1 }),
      record({ tokensAvoided: 0, executionCalls: 1 }),
    ]);
    expect(summary.tokensAvoided).toBe(1000);
    expect(summary.workAvoidedRatio).toBe(0.5);
  });

  it('reports tokens per *successful* task, not per task', () => {
    // A change that halves tokens by failing twice as often is not an
    // improvement. Averaging failures in would hide exactly that.
    const summary = summarizeRun([
      record({ inputTokens: 1000, outputTokens: 0 }),
      record({ outcome: 'failure', inputTokens: 10, outputTokens: 0 }),
    ]);
    expect(summary.tokensPerSuccessfulTask).toBe(1000);
    expect(summary.successRate).toBe(0.5);
  });

  it('takes p50 and p95 from every task, successful or not', () => {
    // Latency is what a person waits, and they wait for failures too.
    const summary = summarizeRun(
      Array.from({ length: 100 }, (_, i) => record({ endToEndMs: (i + 1) * 1000, outcome: i < 50 ? 'success' : 'failure' })),
    );
    expect(summary.p50LatencyMs).toBe(50_000);
    expect(summary.p95LatencyMs).toBe(95_000);
  });

  it('averages quality over the tasks that were scored', () => {
    const summary = summarizeRun([record({ qualityScore: 1 }), record({ qualityScore: 0.5 }), record({ qualityScore: null })]);
    expect(summary.qualityScore).toBeCloseTo(0.75);
  });

  it('reports no quality at all when nothing was scored', () => {
    expect(summarizeRun([record({ qualityScore: null })]).qualityScore).toBeNull();
  });

  it('survives an empty run', () => {
    const summary = summarizeRun([]);
    expect(summary.tasks).toBe(0);
    expect(summary.successRate).toBe(0);
    expect(summary.tokensPerSuccessfulTask).toBe(0);
    expect(summary.qualityScore).toBeNull();
  });

  it('survives a run in which nothing succeeded', () => {
    expect(summarizeRun([record({ outcome: 'failure' })]).tokensPerSuccessfulTask).toBe(0);
  });
});

describe('objectiveScore', () => {
  it('scores the baseline against itself as 1', () => {
    const base = suite();
    expect(objectiveScore(base, base, DEFAULT_WEIGHTS)).toBeCloseTo(1);
  });

  it('falls below 1 when tokens and latency improve at equal quality', () => {
    const score = objectiveScore(suite({ tokensPerSuccessfulTask: 5000, p95LatencyMs: 50_000 }), suite(), DEFAULT_WEIGHTS);
    // 0.4*0.5 + 0.2*0.5 + 0.4*1 (quality unchanged) = 0.7
    expect(score).toBeCloseTo(0.7);
  });

  it('weights the three terms as configured', () => {
    const halved = suite({ tokensPerSuccessfulTask: 5000 });
    expect(objectiveScore(halved, suite(), { tokens: 1, latency: 0 })).toBeCloseTo(0.5);
    expect(objectiveScore(halved, suite(), { tokens: 0, latency: 1 })).toBeCloseTo(1);
    expect(objectiveScore(halved, suite(), { tokens: 0, latency: 0, quality: 1 })).toBeCloseTo(1);
  });

  it('carries the 2:2:1 objective this architecture was approved under', () => {
    expect(DEFAULT_WEIGHTS).toEqual({ tokens: 0.4, quality: 0.4, latency: 0.2 });
    // The same preference `decision/utility.ts` scores a single action with:
    // tokens and quality equal, latency half of either.
    expect(DEFAULT_WEIGHTS.quality).toBe(DEFAULT_WEIGHTS.tokens);
    expect(DEFAULT_WEIGHTS.latency).toBeCloseTo(DEFAULT_WEIGHTS.tokens / 2);
  });

  it('rewards a quality improvement at unchanged cost', () => {
    const better = suite({ qualityScore: 0.95 });
    expect(objectiveScore(better, suite(), DEFAULT_WEIGHTS)).toBeLessThan(1);
  });

  it('penalises a quality regression bought with tokens', () => {
    const cheapAndWorse = suite({ tokensPerSuccessfulTask: 8000, qualityScore: 0.6 });
    expect(objectiveScore(cheapAndWorse, suite(), DEFAULT_WEIGHTS)).toBeGreaterThan(1);
  });

  it('treats an unscored run as neutral on quality rather than as an improvement', () => {
    const unscored = suite({ qualityScore: null });
    expect(objectiveScore(unscored, suite(), { tokens: 0, latency: 0, quality: 1 })).toBeCloseTo(1);
  });

  it('does not divide by a baseline of zero', () => {
    const zero = suite({ tokensPerSuccessfulTask: 0, p95LatencyMs: 0 });
    expect(Number.isFinite(objectiveScore(suite(), zero, DEFAULT_WEIGHTS))).toBe(true);
  });
});

describe('evaluateExperiment', () => {
  const run = (optimized: ReturnType<typeof suite>, epsilon = 0.02) =>
    evaluateExperiment({ baseline: suite(), optimized, weights: DEFAULT_WEIGHTS, epsilon });

  it('rejects an optimization that improves tokens but regresses quality', () => {
    const result = run(suite({ qualityScore: 0.85, tokensPerSuccessfulTask: 5000, p95LatencyMs: 70_000 }));
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('quality');
  });

  it('accepts a Pareto-improving change', () => {
    const result = run(suite({ successRate: 0.96, tokensPerSuccessfulTask: 7000, p95LatencyMs: 75_000 }));
    expect(result.accepted).toBe(true);
    expect(result.tokenDeltaPct).toBeCloseTo(-30);
    expect(result.p95LatencyDeltaPct).toBeCloseTo(-25);
  });

  it('rejects a success-rate regression beyond epsilon and tolerates one within it', () => {
    expect(run(suite({ successRate: 0.9, tokensPerSuccessfulTask: 5000 })).accepted).toBe(false);
    expect(run(suite({ successRate: 0.94, tokensPerSuccessfulTask: 5000 })).accepted).toBe(true);
  });

  it('rejects a change that regresses the objective even with every gate clear', () => {
    const result = run(suite({ tokensPerSuccessfulTask: 20_000 }));
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('objective');
  });

  it('refuses to clear the quality gate when nothing was scored', () => {
    // Silence is not a pass. An unscored run must not be able to ship a quality
    // regression by simply not measuring one.
    const result = evaluateExperiment({
      baseline: suite(), optimized: suite({ qualityScore: null, tokensPerSuccessfulTask: 1000 }),
      weights: DEFAULT_WEIGHTS, epsilon: 0.02,
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('quality');
  });

  it('does not demand quality when the baseline had none either', () => {
    const result = evaluateExperiment({
      baseline: suite({ qualityScore: null }), optimized: suite({ qualityScore: null, tokensPerSuccessfulTask: 5000 }),
      weights: DEFAULT_WEIGHTS, epsilon: 0.02,
    });
    expect(result.accepted).toBe(true);
  });

  it('reports every delta whether it accepts or rejects', () => {
    const result = run(suite({ qualityScore: 0.85 }));
    expect(result.accepted).toBe(false);
    expect(result).toMatchObject({
      tokenDeltaPct: expect.any(Number),
      p95LatencyDeltaPct: expect.any(Number),
      p50LatencyDeltaPct: expect.any(Number),
      successDeltaPct: expect.any(Number),
      qualityDelta: expect.any(Number),
      objectiveBaseline: expect.any(Number),
      objectiveOptimized: expect.any(Number),
    });
  });

  it('names every gate it failed, not just the first', () => {
    const result = run(suite({ qualityScore: 0.5, successRate: 0.5, tokensPerSuccessfulTask: 99_000 }));
    expect(result.reason).toContain('quality');
    expect(result.reason).toContain('success');
  });
});

describe('an arm that bought its saving by refusing to work', () => {
  it('is refused even when the success rate matches', () => {
    const baseline = suite({ tasksStopped: 0 });
    const result = evaluateExperiment({
      baseline,
      // Half the tokens, same success rate — and four tasks the guard killed.
      optimized: suite({ tasksStopped: 4, tokensPerSuccessfulTask: 5_000 }),
      weights: DEFAULT_WEIGHTS,
      epsilon: 0.02,
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/stopped more tasks/);
  });

  it('accepts an arm that stopped no more than the baseline did', () => {
    const result = evaluateExperiment({
      baseline: suite({ tasksStopped: 2 }),
      optimized: suite({ tasksStopped: 2, tokensPerSuccessfulTask: 5_000 }),
      weights: DEFAULT_WEIGHTS,
      epsilon: 0.02,
    });
    expect(result.accepted).toBe(true);
  });
});

describe('summarizeRun — the planner\'s own numbers', () => {
  it('reports context handed over, how much of it was selected, and what was stopped', () => {
    const summary = summarizeRun([
      record({ contextCandidates: 40, contextSelected: 4, contextEstimatedTokens: 1000 }),
      record({ contextCandidates: 20, contextSelected: 4, contextEstimatedTokens: 2000, stopReason: 'Spend cap reached.' }),
    ]);
    expect(summary.contextTokensPerTask).toBe(1500);
    expect(summary.contextSelectionRatio).toBeCloseTo((0.1 + 0.2) / 2);
    expect(summary.tasksStopped).toBe(1);
  });
});
