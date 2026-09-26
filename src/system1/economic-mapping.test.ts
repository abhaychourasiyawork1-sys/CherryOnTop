import { describe, it, expect } from 'vitest';
import { decompositionBoundary, worthSplittingFrom, withHelpfulness } from './economic-mapping.js';
import { calibrate, CALIBRATION_VERSION } from './calibration.js';
import { actionCandidate } from '../decision/actions.js';
import { evaluateActionUtility } from '../decision/utility.js';
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
  it('is derived from the delegation economics, not a universal 0.5', () => {
    const medium = decompositionBoundary('medium')!;
    const high = decompositionBoundary('high')!;
    expect(medium.threshold).toBeCloseTo(1 / 3);
    expect(high.threshold).toBeCloseTo(0.2);
    expect(worthSplittingFrom(0.34, medium)).toBe(true);
    expect(worthSplittingFrom(0.3, medium)).toBe(false);
  });

  it('is absent when no answer could make economics delegate, so nobody asks', () => {
    expect(decompositionBoundary('low')).toBeNull();
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
    const u = evaluateActionUtility(withHelpfulness(validate, 0), state);
    expect(u.score).toBeLessThan(0);
  });
});
