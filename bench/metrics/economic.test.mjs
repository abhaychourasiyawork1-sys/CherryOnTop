import { describe, it, expect } from 'vitest';
import {
  summarizeEconomicRun, compareArms, renderComparison, mean, percentile, deltaPct,
} from './economic.mjs';

/** One task's record, in the shape the ledger emits. */
const record = (over = {}) => ({
  taskId: 't1', outcome: 'success',
  totalTokens: 100_000, endToEndMs: 300_000, qualityScore: 0.9,
  contextEstimatedTokens: 1_200, explorationTokens: 20_000, evidenceTokens: 2_000,
  validationTokens: 3_000, recoveryTokens: 0, duplicatedInformationTokens: 0,
  orchestrationTokens: 300, optimizationRoi: 0.5,
  beneficialInterventionRate: 0.8, memoryNetValue: 0,
  stopReason: null, policyVersion: 'full:ctx-1/exec-1:dec-1',
  ...over,
});

const arm = (records) => summarizeEconomicRun(records);

describe('the primary metric is per successful task', () => {
  it('divides by successes, not by tasks', () => {
    const summary = arm([
      record({ taskId: 'a', totalTokens: 100_000 }),
      record({ taskId: 'b', totalTokens: 40_000, outcome: 'failure' }),
    ]);
    // A change that halves tokens by failing twice as often has not improved
    // anything, and a mean over all tasks would call it a win.
    expect(summary.tokensPerSuccessfulTask).toBe(100_000);
    expect(summary.successRate).toBe(0.5);
  });

  it('reports no figure at all when nothing succeeded', () => {
    const summary = arm([record({ outcome: 'failure' })]);
    expect(summary.tokensPerSuccessfulTask).toBeNull();
  });

  it('counts a validation-downgraded run as unsuccessful', () => {
    // `partial` is what an evidence-backed completion produces for a run that
    // finished and proved nothing.
    expect(arm([record({ outcome: 'partial' })]).successRate).toBe(0);
  });
});

describe('absence is reported as absence', () => {
  it('reports an unscored run as unscored rather than as zero quality', () => {
    expect(arm([record({ qualityScore: null })]).qualityScore).toBeNull();
  });

  it('reports no intervention rate when nothing was reconciled', () => {
    expect(arm([record({ beneficialInterventionRate: null })]).beneficialInterventionRate).toBeNull();
  });

  it('averages only the values that exist', () => {
    expect(mean([1, null, 3, undefined])).toBe(2);
    expect(mean([null, undefined])).toBeNull();
  });

  it('reports no percentile for an empty run', () => {
    expect(percentile([], 95)).toBeNull();
    expect(arm([]).p95LatencyMs).toBeNull();
  });

  it('propagates absence through a delta rather than inventing a change', () => {
    expect(deltaPct(null, 100)).toBeNull();
    expect(deltaPct(100, null)).toBeNull();
    expect(deltaPct(100, 0)).toBeNull();
  });
});

describe('where the tokens went', () => {
  it('reports every component the architecture claims to move', () => {
    const summary = arm([record()]);
    for (const key of [
      'initialContextTokens', 'explorationTokens', 'evidenceTokens', 'validationTokens',
      'recoveryTokens', 'duplicatedInformationTokens', 'orchestrationTokens',
      'optimizationRoi', 'beneficialInterventionRate', 'memoryNetValue',
    ]) {
      expect(summary, key).toHaveProperty(key);
    }
  });

  it('reports orchestration overhead as a share of what was spent', () => {
    const summary = arm([record({ totalTokens: 100_000, orchestrationTokens: 2_000 })]);
    expect(summary.orchestrationOverheadRatio).toBeCloseTo(0.02);
  });

  it('reports duplication as a share of what was spent', () => {
    const summary = arm([record({ totalTokens: 100_000, duplicatedInformationTokens: 5_000 })]);
    expect(summary.duplicationRatio).toBeCloseTo(0.05);
  });

  it('never divides by a run that spent nothing', () => {
    const summary = arm([record({ totalTokens: 0, orchestrationTokens: 0 })]);
    expect(summary.orchestrationOverheadRatio).toBe(0);
    expect(summary.duplicationRatio).toBe(0);
  });
});

describe('the acceptance contract', () => {
  const baseline = () => arm([record({ taskId: 'a' }), record({ taskId: 'b' })]);

  it('accepts a cheaper arm at equal quality, success and latency', () => {
    const full = arm([
      record({ taskId: 'a', totalTokens: 70_000 }),
      record({ taskId: 'b', totalTokens: 70_000 }),
    ]);
    const result = compareArms(baseline(), full);
    expect(result.accepted).toBe(true);
    expect(result.verdict).toBe('improved');
    expect(result.tokenDeltaPct).toBeCloseTo(-30);
  });

  it('refuses an arm that did not get cheaper', () => {
    const full = arm([record({ taskId: 'a' }), record({ taskId: 'b' })]);
    const result = compareArms(baseline(), full);
    expect(result.accepted).toBe(false);
    expect(result.failures.some((f) => f.includes('did not fall'))).toBe(true);
  });

  it('refuses a quality regression bought with tokens', () => {
    const full = arm([
      record({ taskId: 'a', totalTokens: 50_000, qualityScore: 0.6 }),
      record({ taskId: 'b', totalTokens: 50_000, qualityScore: 0.6 }),
    ]);
    const result = compareArms(baseline(), full);
    expect(result.failures).toContain('quality regressed');
  });

  it('refuses an arm that stopped measuring quality', () => {
    // Silence is not a pass: an unscored arm must not be able to ship a quality
    // regression by simply not measuring one.
    const full = arm([
      record({ taskId: 'a', totalTokens: 50_000, qualityScore: null }),
      record({ taskId: 'b', totalTokens: 50_000, qualityScore: null }),
    ]);
    expect(compareArms(baseline(), full).failures.some((f) => f.includes('not scored'))).toBe(true);
  });

  it('refuses an arm that got cheap by failing more often', () => {
    const full = arm([
      record({ taskId: 'a', totalTokens: 50_000 }),
      record({ taskId: 'b', totalTokens: 50_000, outcome: 'failure' }),
    ]);
    expect(compareArms(baseline(), full).failures.some((f) => f.includes('success rate'))).toBe(true);
  });

  it('refuses an arm that got cheap by stopping tasks', () => {
    // The success-rate gate misses the case where the guard stopped a task the
    // baseline would also have failed.
    const stopped = arm([
      record({ taskId: 'a', totalTokens: 50_000 }),
      record({ taskId: 'b', totalTokens: 50_000, stopReason: 'spend cap reached' }),
    ]);
    expect(compareArms(baseline(), stopped).failures.some((f) => f.includes('stopped more tasks'))).toBe(true);
  });

  it('refuses an arm whose latency rose past the tolerance', () => {
    const full = arm([
      record({ taskId: 'a', totalTokens: 50_000, endToEndMs: 900_000 }),
      record({ taskId: 'b', totalTokens: 50_000, endToEndMs: 900_000 }),
    ]);
    expect(compareArms(baseline(), full).failures.some((f) => f.includes('latency'))).toBe(true);
  });

  it('tolerates a latency rise inside the stated tolerance', () => {
    const full = arm([
      record({ taskId: 'a', totalTokens: 50_000, endToEndMs: 330_000 }),
      record({ taskId: 'b', totalTokens: 50_000, endToEndMs: 330_000 }),
    ]);
    expect(compareArms(baseline(), full).accepted).toBe(true);
  });

  it('refuses an arm whose orchestration overhead is not justified', () => {
    const full = arm([
      record({ taskId: 'a', totalTokens: 50_000, orchestrationTokens: 20_000 }),
      record({ taskId: 'b', totalTokens: 50_000, orchestrationTokens: 20_000 }),
    ]);
    expect(compareArms(baseline(), full).failures.some((f) => f.includes('orchestration overhead'))).toBe(true);
  });

  it('refuses to compare two policy generations', () => {
    // Averaging them produces a number describing neither.
    const full = arm([
      record({ taskId: 'a', totalTokens: 50_000, policyVersion: 'full:ctx-2/exec-1:dec-1' }),
      record({ taskId: 'b', totalTokens: 50_000, policyVersion: 'full:ctx-1/exec-1:dec-1' }),
    ]);
    expect(compareArms(baseline(), full).failures.some((f) => f.includes('policy generations'))).toBe(true);
  });

  it('compares the two arms of one generation happily', () => {
    const full = arm([
      record({ taskId: 'a', totalTokens: 50_000, policyVersion: 'full:ctx-1/exec-1:dec-1' }),
      record({ taskId: 'b', totalTokens: 50_000, policyVersion: 'baseline:ctx-1/exec-1:dec-1' }),
    ]);
    expect(compareArms(baseline(), full).failures.some((f) => f.includes('policy generations'))).toBe(false);
  });
});

describe('a run that failed before it finished', () => {
  it('still produces a usable summary', () => {
    const summary = arm([
      record({ taskId: 'a', outcome: 'failure', totalTokens: 10_000, qualityScore: null }),
      record({ taskId: 'b', outcome: 'budget_exhausted', totalTokens: 90_000, qualityScore: null, stopReason: 'spend cap' }),
    ]);
    expect(summary.tasks).toBe(2);
    expect(summary.tokensPerSuccessfulTask).toBeNull();
    expect(summary.tasksStopped).toBe(1);
    expect(Number.isFinite(summary.orchestrationOverheadRatio)).toBe(true);
  });

  it('reports the comparison as inconclusive rather than as a result', () => {
    const empty = arm([]);
    const result = compareArms(empty, empty);
    expect(result.verdict).toBe('inconclusive');
    expect(result.accepted).toBe(false);
  });

  it('never throws on an empty or malformed record set', () => {
    expect(() => summarizeEconomicRun([])).not.toThrow();
    expect(() => summarizeEconomicRun(undefined)).not.toThrow();
    expect(() => summarizeEconomicRun([{ outcome: 'success' }])).not.toThrow();
  });
});

describe('the report', () => {
  it('puts the primary metric first, with quality and latency beside it', () => {
    const baseline = arm([record()]);
    const full = arm([record({ totalTokens: 60_000 })]);
    const lines = renderComparison(baseline, full, compareArms(baseline, full)).split('\n');
    const metrics = lines.slice(2).map((line) => line.split('|')[1]?.trim());
    expect(metrics[0]).toBe('tokens / successful task');
    expect(metrics.slice(1, 4)).toEqual(['quality', 'success rate', 'p95 latency (ms)']);
  });

  it('says "not measured" rather than printing a zero it did not observe', () => {
    const summary = arm([record({ qualityScore: null })]);
    const rendered = renderComparison(summary, summary, compareArms(summary, summary));
    expect(rendered).toContain('not measured');
  });

  it('names every regression and every inconclusive area', () => {
    const baseline = arm([record()]);
    const full = arm([record({ qualityScore: 0.3 })]);
    const rendered = renderComparison(baseline, full, compareArms(baseline, full));
    expect(rendered).toContain('regression: quality regressed');
  });
});
