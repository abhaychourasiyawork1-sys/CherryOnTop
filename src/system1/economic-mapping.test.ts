import { describe, it, expect } from 'vitest';
import { decompositionBoundary, worthSplittingFrom, withHelpfulness } from './economic-mapping.js';
import { calibrate, CALIBRATION_VERSION } from './calibration.js';
import { actionCandidate } from '../decision/actions.js';
import { evaluateAction } from '../decision/utility.js';
import { initialEconomicState } from '../decision/state.js';
import type { DecisionJudgment } from './types.js';

describe('calibration', () => {
  const j = (p: number): DecisionJudgment => ({
    requestId: 'r', provider: 'laya', surface: 'action.helpful', primitive: 'noul', result: { probability: p },
    calibration: { rawProbability: p, version: 'uncalibrated' }, confidence: { provider: 2, orchestration: 0 },
    metadata: { model: 'm', questionVersion: 'v', inputDigest: 'd', stateVersion: 0, latencyMs: 0, inputTokens: 0 },
  });

  it('clamps out-of-range probabilities', () => {
    expect(calibrate(j(1.4), 0.5).result.probability).toBe(1);
    expect(calibrate(j(-0.2), 0.5).result.probability).toBe(0);
    expect(calibrate(j(0.3), 0.5).confidence.provider).toBe(1);
  });

  it('is explicit and versioned, and keeps orchestration confidence separate', () => {
    const c = calibrate(j(0.42), 0.3);
    expect(c.calibration).toEqual({ rawProbability: 0.42, calibratedProbability: 0.42, version: CALIBRATION_VERSION });
    expect(c.confidence.orchestration).toBe(0.3);
    expect(c.result.probability).toBe(0.42);
  });
});

describe('decomposability boundary', () => {
  const price = (expectedUsd: number, conservativeUsd = expectedUsd) => ({ expectedUsd, conservativeUsd });
  const pricing = (solo: number, plan: number, children: number, synth: number) => ({
    solo: price(solo), plan: price(plan), children: price(children), synth: price(synth), childCount: 2,
  });

  it('is derived from what each way of doing the work costs, not a universal 0.5', () => {
    // solo 1.0; plan .1, children .3, synth .1 -> a real split saves .5 net of the plan,
    // and trying is worth it once p·.5 >= (1-p)·.1.
    const cheapPlan = decompositionBoundary(pricing(1, 0.1, 0.3, 0.1))!;
    expect(cheapPlan.gain).toBeCloseTo(0.5);
    expect(cheapPlan.threshold).toBeCloseTo(0.1 / 0.6);
    // A dearer plan needs a likelier split before it is worth buying.
    expect(decompositionBoundary(pricing(1, 0.3, 0.3, 0.1))!.threshold).toBeGreaterThan(cheapPlan.threshold);
    expect(worthSplittingFrom(0.18, cheapPlan)).toBe(true);
    expect(worthSplittingFrom(0.15, cheapPlan)).toBe(false);
  });

  it('is absent when no answer could make delegating cheaper, so nobody asks', () => {
    expect(decompositionBoundary(pricing(0.4, 0.1, 0.3, 0.1))).toBeNull();
  });

  it('is absent when the market could not price the work', () => {
    expect(decompositionBoundary(pricing(Number.POSITIVE_INFINITY, 0.1, Number.NaN, 0.1))).toBeNull();
  });
});

describe('helpfulness', () => {
  const state = initialEconomicState({ goal: 'g', totalTokenBudget: 10_000 });
  const validate = actionCandidate({
    id: 'v', kind: 'validate', capability: 'c', confidence: 0.8,
    expectedQualityBenefit: 0.6, tokenCost: 500, failureRisk: 0.2,
  });

  it('enters expected benefit once, leaving costs and failure risk alone', () => {
    const scaled = withHelpfulness(validate, 0.5);
    expect(scaled.expectedQualityBenefit).toBeCloseTo(0.3);
    expect(scaled.tokenCost).toBe(500);
    expect(scaled.failureRisk).toBe(0.2);
    expect(() => withHelpfulness(scaled, 0.5)).toThrow(/already applied/);
  });

  it('a certainly-useless action keeps its full cost', () => {
    const u = evaluateAction(withHelpfulness(validate, 0), state);
    expect(u.advantageUsd).toBeLessThan(0);
  });
});
