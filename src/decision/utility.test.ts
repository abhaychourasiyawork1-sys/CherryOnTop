import { describe, it, expect } from 'vitest';
import { evaluateActionUtility, DEFAULT_UTILITY_WEIGHTS, type UtilityWeights } from './utility.js';
import { actionCandidate } from './actions.js';
import { initialEconomicState, normalizeEconomicState, type EconomicState } from './state.js';

function state(over: Partial<EconomicState> = {}): EconomicState {
  const base = initialEconomicState({
    goal: 'g', totalTokenBudget: 10_000, qualityFloor: 0.7,
    availableCapabilities: ['context.select'],
  });
  return normalizeEconomicState({
    ...base,
    ...over,
    resources: { ...base.resources, latencyBudgetMs: 600_000, ...over.resources },
  });
}

/** An action with no effects at all: every term zero, so any single dimension
 *  can be varied on its own and the contribution read straight off the score. */
const inert = (over = {}) => actionCandidate({ id: 'a', kind: 'continue', capability: 'agent.continue', confidence: 1, ...over });

describe('the 2:2:1 objective', () => {
  it('defaults to tokens 0.4, quality 0.4, latency 0.2', () => {
    expect(DEFAULT_UTILITY_WEIGHTS).toEqual({ tokens: 0.4, quality: 0.4, latency: 0.2 });
  });

  it('gives tokens and quality equal weight, and latency half of either', () => {
    const s = state();
    // One full unit of each dimension: the entire token budget saved, the whole
    // quality range gained, the entire latency budget saved.
    const tokens = evaluateActionUtility(inert({ expectedTokenBenefit: 10_000 }), s).score;
    const quality = evaluateActionUtility(inert({ expectedQualityBenefit: 1 }), s).score;
    const latency = evaluateActionUtility(inert({ expectedLatencyBenefit: 600_000 }), s).score;

    expect(tokens).toBeCloseTo(0.4, 6);
    expect(quality).toBeCloseTo(0.4, 6);
    expect(latency).toBeCloseTo(0.2, 6);
    expect(tokens).toBeCloseTo(quality, 6);
    expect(latency).toBeCloseTo(tokens / 2, 6);
  });

  it('honours a caller-supplied weighting', () => {
    const tokensOnly: UtilityWeights = { tokens: 1, quality: 0, latency: 0 };
    expect(evaluateActionUtility(inert({ expectedTokenBenefit: 10_000 }), state(), tokensOnly).score).toBeCloseTo(1, 6);
    expect(evaluateActionUtility(inert({ expectedQualityBenefit: 1 }), state(), tokensOnly).score).toBeCloseTo(0, 6);
  });

  it('charges cost against benefit in the same normalized units', () => {
    const s = state();
    const even = evaluateActionUtility(inert({ expectedTokenBenefit: 2000, tokenCost: 2000 }), s);
    expect(even.score).toBeCloseTo(0, 6);
    expect(even.expectedBenefit).toBeGreaterThan(0);
    expect(even.expectedCost).toBeGreaterThan(0);
  });

  it('counts coordination and orchestration overhead as real cost', () => {
    const s = state();
    const bare = evaluateActionUtility(inert({ expectedTokenBenefit: 4000 }), s).score;
    const withOverhead = evaluateActionUtility(
      inert({ expectedTokenBenefit: 4000, coordinationCost: 1000, orchestrationCost: 1000 }), s,
    ).score;
    expect(withOverhead).toBeLessThan(bare);
    expect(withOverhead).toBeCloseTo(0.4 * (4000 - 2000) / 10_000, 6);
  });

  it('discounts by confidence and by the risk the action simply fails', () => {
    const s = state();
    const sure = evaluateActionUtility(inert({ expectedTokenBenefit: 8000, confidence: 1, failureRisk: 0 }), s).score;
    const unsure = evaluateActionUtility(inert({ expectedTokenBenefit: 8000, confidence: 0.5, failureRisk: 0 }), s).score;
    const risky = evaluateActionUtility(inert({ expectedTokenBenefit: 8000, confidence: 1, failureRisk: 0.5 }), s).score;
    expect(unsure).toBeCloseTo(sure * 0.5, 6);
    expect(risky).toBeCloseTo(sure * 0.5, 6);
  });

  it('does not let confidence rescue a negative action', () => {
    const s = state();
    const bad = inert({ tokenCost: 5000 });
    const confident = evaluateActionUtility(bad, s).score;
    const doubtful = evaluateActionUtility({ ...bad, confidence: 0.2 }, s).score;
    // Discounting moves a loss towards zero, never above it.
    expect(confident).toBeLessThan(0);
    expect(doubtful).toBeLessThan(0);
    expect(doubtful).toBeGreaterThan(confident);
  });

  it('is deterministic and touches nothing outside its inputs', () => {
    const s = state();
    const a = inert({ expectedTokenBenefit: 1234, tokenCost: 99 });
    const snapshot = structuredClone(s);
    expect(evaluateActionUtility(a, s)).toEqual(evaluateActionUtility(a, s));
    expect(s).toEqual(snapshot);
  });
});

describe('hard constraints outrank the score', () => {
  it('rejects an action whose quality risk breaches the floor, however large its token benefit', () => {
    const s = state();
    const cheapAndWrong = inert({ expectedTokenBenefit: 1_000_000, qualityRisk: 0.5 });
    const verdict = evaluateActionUtility(cheapAndWrong, s);
    expect(verdict.allowed).toBe(false);
    expect(verdict.qualityFloorSatisfied).toBe(false);
    expect(verdict.reasonCodes).toContain('quality_floor');
  });

  it('lets a quality benefit offset a quality risk up to the floor', () => {
    const s = state();
    expect(evaluateActionUtility(inert({ qualityRisk: 0.4, expectedQualityBenefit: 0.2 }), s).allowed).toBe(true);
    expect(evaluateActionUtility(inert({ qualityRisk: 0.4, expectedQualityBenefit: 0.05 }), s).allowed).toBe(false);
  });

  it('respects a floor raised above the default', () => {
    const strict = state({ constraints: { qualityFloor: 0.95, hardStop: false } });
    expect(evaluateActionUtility(inert({ qualityRisk: 0.1 }), strict).allowed).toBe(false);
    expect(evaluateActionUtility(inert({ qualityRisk: 0.02 }), strict).allowed).toBe(true);
  });

  it('rejects an action flagged unsafe even when its expected utility is positive', () => {
    const s = state();
    const profitable = inert({ expectedTokenBenefit: 9000, metadata: { unsafe: true } });
    const verdict = evaluateActionUtility(profitable, s);
    expect(verdict.score).toBeGreaterThan(0);
    expect(verdict.allowed).toBe(false);
    expect(verdict.safetySatisfied).toBe(false);
    expect(verdict.reasonCodes).toContain('safety_violation');
  });

  it('rejects an action that needs a person to approve it', () => {
    const verdict = evaluateActionUtility(inert({ metadata: { requiresApproval: true } }), state());
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasonCodes).toContain('requires_approval');
  });

  it('allows only stopping once the state carries a hard stop', () => {
    const stopped = state({ constraints: { qualityFloor: 0.7, hardStop: true } });
    expect(evaluateActionUtility(inert({ expectedTokenBenefit: 9000 }), stopped).allowed).toBe(false);
    expect(evaluateActionUtility(inert({ expectedTokenBenefit: 9000 }), stopped).reasonCodes).toContain('hard_stop');
    expect(evaluateActionUtility(actionCandidate({ id: 's', kind: 'stop', capability: 'runtime.stop' }), stopped).allowed).toBe(true);
  });

  it('refuses to spend tokens the task does not have', () => {
    const nearlySpent = state({ resources: { ...state().resources, consumedTokens: 9500 } });
    expect(evaluateActionUtility(inert({ kind: 'explore', tokenCost: 2000 }), nearlySpent).reasonCodes).toContain('insufficient_budget');
    expect(evaluateActionUtility(inert({ kind: 'explore', tokenCost: 200 }), nearlySpent).allowed).toBe(true);
  });

  it('protects the recovery reserve from ordinary spending but not from recovery', () => {
    const reserved = state({
      resources: { ...state().resources, consumedTokens: 8000, recoveryReserve: 1500 },
    });
    expect(evaluateActionUtility(inert({ kind: 'explore', tokenCost: 1200 }), reserved).allowed).toBe(false);
    expect(evaluateActionUtility(inert({ kind: 'recover', tokenCost: 1200 }), reserved).allowed).toBe(true);
  });

  it('never charges continuing or stopping against the budget', () => {
    const spent = state({ resources: { ...state().resources, consumedTokens: 10_000 } });
    expect(evaluateActionUtility(inert({ kind: 'continue' }), spent).allowed).toBe(true);
    expect(evaluateActionUtility(actionCandidate({ id: 's', kind: 'stop', capability: 'r' }), spent).allowed).toBe(true);
  });

  it('reports every constraint that fired, not just the first', () => {
    const stopped = state({ constraints: { qualityFloor: 0.7, hardStop: true } });
    const verdict = evaluateActionUtility(inert({ qualityRisk: 0.9, metadata: { unsafe: true } }), stopped);
    expect(verdict.reasonCodes).toEqual(expect.arrayContaining(['hard_stop', 'safety_violation', 'quality_floor']));
  });
});

describe('edge cases', () => {
  const s = () => state();

  it('handles a zero-benefit, zero-cost action as exactly neutral', () => {
    const verdict = evaluateActionUtility(inert(), s());
    expect(verdict.score).toBe(0);
    expect(verdict.allowed).toBe(true);
  });

  it('handles a benefit larger than the whole budget without losing its sign', () => {
    const verdict = evaluateActionUtility(inert({ expectedTokenBenefit: 10_000_000 }), s());
    expect(verdict.score).toBeGreaterThan(0);
    expect(Number.isFinite(verdict.score)).toBe(true);
  });

  it('does not divide by a zero budget', () => {
    const broke = normalizeEconomicState({ ...s(), resources: { ...s().resources, totalTokenBudget: 0 } });
    const verdict = evaluateActionUtility(inert({ expectedTokenBenefit: 500, tokenCost: 100 }), broke);
    expect(Number.isFinite(verdict.score)).toBe(true);
  });

  it('does not divide by a missing latency budget', () => {
    const noLatency = normalizeEconomicState({
      ...s(), resources: { ...s().resources, latencyBudgetMs: undefined },
    });
    const verdict = evaluateActionUtility(inert({ expectedLatencyBenefit: 30_000 }), noLatency);
    expect(Number.isFinite(verdict.score)).toBe(true);
    expect(verdict.score).toBeGreaterThan(0);
  });

  it('survives a candidate carrying non-finite numbers', () => {
    const verdict = evaluateActionUtility(
      { ...inert(), expectedTokenBenefit: Number.NaN, tokenCost: Number.POSITIVE_INFINITY },
      s(),
    );
    expect(Number.isFinite(verdict.score)).toBe(true);
  });
});
