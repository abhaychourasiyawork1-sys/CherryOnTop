import { describe, it, expect } from 'vitest';
import { scoreDelegation } from './economics.js';

describe('scoreDelegation', () => {
  it('computes score as value minus total cost minus risk', () => {
    const result = scoreDelegation({
      estimatedValue: 1, modelCost: 0.1, latencyCost: 0.1,
      coordinationCost: 0.1, verificationCost: 0.1, riskPenalty: 0.1, threshold: 0.3,
    });
    expect(result.score).toBeCloseTo(0.5, 5); // 1 - 0.4 - 0.1
  });

  it('recommends delegation when score meets or exceeds the threshold', () => {
    const result = scoreDelegation({
      estimatedValue: 1, modelCost: 0, latencyCost: 0, coordinationCost: 0,
      verificationCost: 0, riskPenalty: 0, threshold: 0.5,
    });
    expect(result.score).toBe(1);
    expect(result.delegate).toBe(true);
  });

  it('recommends against delegation when score falls short of the threshold', () => {
    const result = scoreDelegation({
      estimatedValue: 0.2, modelCost: 0.1, latencyCost: 0.1, coordinationCost: 0.1,
      verificationCost: 0.1, riskPenalty: 0, threshold: 0.3,
    });
    expect(result.delegate).toBe(false);
  });

  it('returns the full input as the breakdown, for audit', () => {
    const input = { estimatedValue: 1, modelCost: 0.1, latencyCost: 0.1, coordinationCost: 0.1, verificationCost: 0.1, riskPenalty: 0, threshold: 0.3 };
    const result = scoreDelegation(input);
    expect(result.breakdown).toEqual(input);
  });
});
