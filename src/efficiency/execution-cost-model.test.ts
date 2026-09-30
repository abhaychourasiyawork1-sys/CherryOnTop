import { describe, it, expect } from 'vitest';
import {
  quantile, estimateQuantiles, riskAdjusted, riskAversion, coverageOf, MIN_SAMPLES, COST_MODEL_VERSION,
  type CostSample,
} from './execution-cost-model.js';

const sample = (tokens: number, over: Partial<CostSample> = {}): CostSample => ({ role: 'execute', model: 'sonnet', tokens, ...over });
const many = (values: number[], over: Partial<CostSample> = {}) => values.map((v) => sample(v, over));

describe('quantiles', () => {
  it('interpolates between ranks and is exact at the ends', () => {
    const sorted = [10, 20, 30, 40, 50];
    expect(quantile(sorted, 0)).toBe(10);
    expect(quantile(sorted, 0.5)).toBe(30);
    expect(quantile(sorted, 1)).toBe(50);
    expect(quantile(sorted, 0.75)).toBe(40);
    expect(quantile(sorted, 0.9)).toBeCloseTo(46);
  });

  it('is total on tiny inputs', () => {
    expect(quantile([7], 0.9)).toBe(7);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });
});

describe('estimating what a dispatch will cost from what similar ones did', () => {
  it('says nothing at all until there is enough history — the caller then keeps its prior', () => {
    expect(estimateQuantiles(many([100, 200, 300, 400]), { role: 'execute', model: 'sonnet' })).toBeNull();
    expect(MIN_SAMPLES).toBeGreaterThan(4);
    expect(estimateQuantiles([], { role: 'execute' })).toBeNull();
  });

  it('reports p50 ≤ p75 ≤ p90 and how much it rests on', () => {
    const q = estimateQuantiles(many([100, 900, 300, 500, 700, 200, 800, 400, 600, 1000]), { role: 'execute', model: 'sonnet' })!;
    expect(q.p50).toBeLessThanOrEqual(q.p75);
    expect(q.p75).toBeLessThanOrEqual(q.p90);
    expect(q.sampleCount).toBe(10);
    expect(q.modelVersion).toBe(COST_MODEL_VERSION);
    expect(q.p50).toBeCloseTo(550);
  });

  it('prefers the most specific segment that has enough samples, and widens only when it must', () => {
    const cheap = many([100, 110, 120, 130, 140], { effort: 'low' });
    const dear = many([1000, 1100, 1200, 1300, 1400], { effort: 'high' });
    const all = [...cheap, ...dear];
    const low = estimateQuantiles(all, { role: 'execute', model: 'sonnet', effort: 'low' })!;
    const high = estimateQuantiles(all, { role: 'execute', model: 'sonnet', effort: 'high' })!;
    expect(low.p50).toBe(120);
    expect(high.p50).toBe(1200);
    expect(low.segment).toContain('effort');
    // An effort with too little history is priced from the model as a whole.
    const unseen = estimateQuantiles(all, { role: 'execute', model: 'sonnet', effort: 'max' })!;
    expect(unseen.segment).not.toContain('effort');
    expect(unseen.sampleCount).toBe(10);
  });

  it('separates task classes, models and roles', () => {
    const all = [
      ...many([100, 100, 100, 100, 100], { taskClass: 'trivial_edit' }),
      ...many([900, 900, 900, 900, 900], { taskClass: 'debugging' }),
      ...many([50, 50, 50, 50, 50], { role: 'plan' }),
      ...many([5_000, 5_000, 5_000, 5_000, 5_000], { model: 'opus', taskClass: 'debugging' }),
    ];
    expect(estimateQuantiles(all, { role: 'execute', model: 'sonnet', taskClass: 'trivial_edit' })!.p50).toBe(100);
    expect(estimateQuantiles(all, { role: 'execute', model: 'sonnet', taskClass: 'debugging' })!.p50).toBe(900);
    expect(estimateQuantiles(all, { role: 'plan' })!.p50).toBe(50);
    expect(estimateQuantiles(all, { role: 'execute', model: 'opus' })!.p50).toBe(5_000);
  });

  it('counts failed and killed runs: their spend was real, and a model that keeps dying expensively is expensive', () => {
    const finished = many([100, 100, 100, 100, 100]);
    const killed = many([900, 900, 900, 900, 900]).map((s) => ({ ...s, outcome: 'killed' as const }));
    const q = estimateQuantiles([...finished, ...killed], { role: 'execute', model: 'sonnet' })!;
    expect(q.p90).toBe(900);
  });

  it('ignores samples that carry no usable number', () => {
    const q = estimateQuantiles([...many([100, 200, 300, 400, 500]), sample(Number.NaN), sample(-5), sample(0)], { role: 'execute', model: 'sonnet' })!;
    expect(q.sampleCount).toBe(5);
  });
});

describe('risk-adjusted cost', () => {
  const q = { p50: 1_000, p75: 1_400, p90: 2_000, sampleCount: 20, modelVersion: COST_MODEL_VERSION, segment: 'role+model' };

  it('sits at the median for no aversion and the p90 for full aversion', () => {
    expect(riskAdjusted(q, 0)).toBe(1_000);
    expect(riskAdjusted(q, 1)).toBe(2_000);
    expect(riskAdjusted(q, 0.5)).toBe(1_500);
    expect(riskAdjusted(q, 7)).toBe(2_000);
    expect(riskAdjusted(q, -1)).toBe(1_000);
  });

  it('grows with how much of the budget is gone and how much correctness is demanded', () => {
    const relaxed = riskAversion({ qualityFloor: 0.5, budgetSpentShare: 0 });
    const strict = riskAversion({ qualityFloor: 0.95, budgetSpentShare: 0 });
    const tight = riskAversion({ qualityFloor: 0.5, budgetSpentShare: 0.9 });
    expect(strict).toBeGreaterThan(relaxed);
    expect(tight).toBeGreaterThan(relaxed);
    for (const v of [relaxed, strict, tight, riskAversion({ qualityFloor: 2, budgetSpentShare: 9 }), riskAversion({ qualityFloor: -1, budgetSpentShare: -1 })]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('checking the model against what happened', () => {
  it('reports how often the actual cost fell inside each predicted quantile', () => {
    const q = { p50: 100, p75: 150, p90: 200, sampleCount: 10, modelVersion: COST_MODEL_VERSION, segment: 's' };
    const c = coverageOf([
      { predicted: q, actual: 90 }, { predicted: q, actual: 120 }, { predicted: q, actual: 180 }, { predicted: q, actual: 500 },
    ]);
    expect(c.n).toBe(4);
    expect(c.p50).toBe(0.25);
    expect(c.p75).toBe(0.5);
    expect(c.p90).toBe(0.75);
    expect(c.medianRelativeError).toBeGreaterThan(0);
  });

  it('is empty rather than NaN with no records', () => {
    expect(coverageOf([])).toEqual({ n: 0, p50: 0, p75: 0, p90: 0, medianRelativeError: 0 });
  });
});
