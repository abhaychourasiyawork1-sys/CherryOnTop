import { describe, it, expect } from 'vitest';
import {
  evaluateAction, hardConstraints, stateValue, signalEstimate, deterministicEstimate, reworkCostTokens,
  DEFAULT_USD_PER_TOKEN,
} from './utility.js';
import { actionCandidate, type ActionCandidate } from './actions.js';
import { initialEconomicState, normalizeEconomicState, type EconomicState } from './state.js';

function state(over: Partial<EconomicState> = {}): EconomicState {
  const base = initialEconomicState({ goal: 'g', totalTokenBudget: 10_000, qualityFloor: 0.7 });
  return normalizeEconomicState({
    ...base,
    ...over,
    resources: { ...base.resources, latencyBudgetMs: 600_000, ...over.resources },
  });
}

const of = (over: Partial<ActionCandidate> = {}) =>
  actionCandidate({ id: 'a', kind: 'acquire_evidence', capability: `cap.${over.kind ?? 'acquire_evidence'}`, confidence: 1, ...over });

describe('V(s): the expected cost of finishing from here', () => {
  it('is zero once the task is validated complete', () => {
    const done = state({ validation: { required: true, confidence: 1, status: 'passed' } });
    expect(stateValue(done)).toEqual({ tokens: 0, usd: 0 });
  });

  it('grows with failure pressure, because a failing run will need recovering', () => {
    const calm = state();
    const failing = state({ trajectory: { ...calm.trajectory, failurePressure: 0.8 } });
    expect(stateValue(failing).tokens).toBeGreaterThan(stateValue(calm).tokens);
  });

  it('shrinks as progress closes the remaining work', () => {
    const early = state();
    const late = state({ trajectory: { ...early.trajectory, progress: 0.8 } });
    expect(stateValue(late).tokens).toBeLessThan(stateValue(early).tokens);
  });

  it('prices tokens in dollars at the state’s own rate, or a non-zero default', () => {
    const s = state();
    expect(stateValue(s).usd).toBeCloseTo(stateValue(s).tokens * DEFAULT_USD_PER_TOKEN);
    const dear = state({ resources: { ...s.resources, usdPerToken: 1e-5 } });
    expect(stateValue(dear).usd).toBeCloseTo(stateValue(dear).tokens * 1e-5);
  });
});

describe('Q(s,a) = C_now + E[V(s′)]', () => {
  it('prices continue at V(s), not at zero', () => {
    const s = state();
    const e = evaluateAction(of({ kind: 'continue' }), s);
    expect(e.estimate.immediateCost.usd).toBe(0);
    expect(e.expectedCostUsd).toBeCloseTo(stateValue(s).usd);
    expect(e.expectedCostUsd).toBeGreaterThan(0);
    expect(e.advantageUsd).toBeCloseTo(0);
  });

  it('lets an action that costs something now beat continue when it saves more later', () => {
    const s = state();
    const e = evaluateAction(of({ tokenCost: 500, expectedTokenBenefit: 3000 }), s);
    expect(e.estimate.immediateCost.tokens).toBe(500);
    expect(e.advantageUsd).toBeGreaterThan(0);
  });

  it('charges coordination and orchestration overhead as real cost', () => {
    const s = state();
    const bare = evaluateAction(of({ tokenCost: 100 }), s);
    const loaded = evaluateAction(of({ tokenCost: 100, coordinationCost: 200, orchestrationCost: 50 }), s);
    expect(loaded.estimate.immediateCost.tokens).toBe(350);
    expect(loaded.expectedCostUsd).toBeGreaterThan(bare.expectedCostUsd);
  });

  it('values a drop in the chance of rework at what the rework would cost', () => {
    const s = state();
    const validate = evaluateAction(of({ kind: 'validate', expectedQualityBenefit: 0.3 }), s);
    expect(validate.advantageUsd).toBeGreaterThan(0);
    expect(reworkCostTokens(s)).toBeGreaterThan(0);
  });

  it('prices failure as a step towards a retry, so a risky action costs more', () => {
    const s = state();
    const sure = evaluateAction(of({ expectedTokenBenefit: 1000 }), s);
    const flaky = evaluateAction(of({ expectedTokenBenefit: 1000, failureRisk: 0.6 }), s);
    expect(flaky.expectedCostUsd).toBeGreaterThan(sure.expectedCostUsd);
    expect(flaky.estimate.outcomes.map((o) => o.probability)).toEqual([0.4, 0.6]);
  });

  it('widens the bound on a doubtful saving, and never on a certain one', () => {
    const s = state();
    const sure = evaluateAction(of({ expectedTokenBenefit: 2000, confidence: 1 }), s);
    const doubtful = evaluateAction(of({ expectedTokenBenefit: 2000, confidence: 0.3 }), s);
    expect(doubtful.expectedCostUsd).toBeCloseTo(sure.expectedCostUsd);
    expect(doubtful.conservativeCostUsd).toBeGreaterThan(sure.conservativeCostUsd);
  });

  it('never turns a loss into a gain by being unsure of it', () => {
    const s = state();
    const loss = evaluateAction(of({ tokenCost: 2000, confidence: 0.1 }), s);
    expect(loss.advantageUsd).toBeLessThan(0);
    expect(loss.conservativeCostUsd).toBeGreaterThanOrEqual(loss.expectedCostUsd);
  });

  it('does not buy information twice: its value is the rediscovery it avoids', () => {
    const s = state();
    const blind = evaluateAction(of({ tokenCost: 100 }), s);
    const informative = evaluateAction(of({ tokenCost: 100, expectedInformationGain: 0.9 }), s);
    expect(informative.conservativeCostUsd).toBeCloseTo(blind.conservativeCostUsd);
    expect(informative.estimate.outcomes[0].nextStateDelta.informationGain).toBe(0.9);
  });

  it('is deterministic and does not touch the state it prices', () => {
    const s = state();
    const snapshot = JSON.stringify(s);
    const a = evaluateAction(of({ expectedTokenBenefit: 1234, tokenCost: 99 }), s);
    const b = evaluateAction(of({ expectedTokenBenefit: 1234, tokenCost: 99 }), s);
    expect(a).toEqual(b);
    expect(JSON.stringify(s)).toBe(snapshot);
  });
});

describe('stop is terminal, not cheap', () => {
  it('is infeasible on a task that is neither finished nor forbidden to continue', () => {
    const e = evaluateAction(of({ kind: 'stop' }), state());
    expect(e.allowed).toBe(false);
    expect(e.reasonCodes).toContain('stop_not_terminal');
  });

  it('is free and final once the task is validated', () => {
    const done = state({ validation: { required: true, confidence: 1, status: 'passed' } });
    const estimate = deterministicEstimate(of({ kind: 'stop' }), done)!;
    expect(estimate.provenance).toBe('deterministic');
    expect(estimate.outcomes).toEqual([expect.objectContaining({ completed: true, probability: 1 })]);
    expect(evaluateAction(of({ kind: 'stop' }), done).allowed).toBe(true);
  });

  it('is the only thing allowed under a hard stop', () => {
    const stopped = state({ constraints: { qualityFloor: 0.7, hardStop: true } });
    expect(evaluateAction(of({ kind: 'stop' }), stopped).allowed).toBe(true);
    expect(evaluateAction(of({ kind: 'continue' }), stopped).reasonCodes).toContain('hard_stop');
    expect(evaluateAction(of({ expectedTokenBenefit: 9e9 }), stopped).allowed).toBe(false);
  });
});

describe('hard constraints outrank every cost', () => {
  it('refuses an unsafe action however much it saves', () => {
    const e = evaluateAction(of({ expectedTokenBenefit: 1e9, metadata: { unsafe: true } }), state());
    expect(e.advantageUsd).toBeGreaterThan(0);
    expect(e.allowed).toBe(false);
    expect(e.safetySatisfied).toBe(false);
    expect(e.reasonCodes).toContain('safety_violation');
  });

  it('refuses an action that needs a person to approve it', () => {
    expect(evaluateAction(of({ metadata: { requiresApproval: true } }), state()).reasonCodes).toContain('requires_approval');
  });

  it('refuses an unavailable capability as a fact, not a price', () => {
    const e = evaluateAction(of({ metadata: { infeasible: 'harness_down' } }), state());
    expect(e.allowed).toBe(false);
    expect(e.reasonCodes).toContain('unavailable:harness_down');
  });

  it('checks the quality floor against the conservative bound, not the mean', () => {
    // Mean quality 0.75 clears a 0.7 floor; at low confidence its lower bound
    // does not.
    const risky = (confidence: number) => of({ qualityRisk: 0.25, expectedTokenBenefit: 5000, confidence });
    expect(evaluateAction(risky(1), state()).qualityFloorSatisfied).toBe(true);
    expect(evaluateAction(risky(0.2), state()).qualityFloorSatisfied).toBe(false);
    expect(evaluateAction(risky(0.2), state()).reasonCodes).toContain('quality_floor');
  });

  it('respects a floor raised above the default', () => {
    const strict = state({ constraints: { qualityFloor: 0.95, hardStop: false } });
    expect(evaluateAction(of({ qualityRisk: 0.1 }), strict).allowed).toBe(false);
  });

  it('refuses to spend tokens the task does not have, including what others reserved', () => {
    const s = state();
    expect(evaluateAction(of({ tokenCost: 20_000 }), s).reasonCodes).toContain('insufficient_budget');
    const reserved = state({ resources: { ...s.resources, reservedTokens: 9_900 } });
    expect(evaluateAction(of({ tokenCost: 500 }), reserved).reasonCodes).toContain('insufficient_budget');
  });

  it('refuses to spend dollars beyond the task’s authority', () => {
    const s = state({ resources: { ...state().resources, budgetUsd: 1, spentUsd: 0.99, usdPerToken: 1e-4 } });
    expect(evaluateAction(of({ tokenCost: 500 }), s).reasonCodes).toContain('insufficient_budget_usd');
  });

  it('protects the recovery reserve from ordinary spending but not from recovery', () => {
    const s = state({ resources: { ...state().resources, recoveryReserve: 9_000 } });
    expect(hardConstraints(of({ tokenCost: 2_000 }), s).reasonCodes).toContain('insufficient_budget');
    expect(hardConstraints(of({ kind: 'recover', tokenCost: 2_000 }), s).allowed).toBe(true);
  });

  it('never charges continuing against an exhausted budget', () => {
    const broke = state({ resources: { ...state().resources, consumedTokens: 10_000 } });
    expect(evaluateAction(of({ kind: 'continue' }), broke).allowed).toBe(true);
  });

  it('makes interventions infeasible under a fault, and leaves the null action alone', () => {
    const s = state();
    expect(hardConstraints(of({ expectedTokenBenefit: 5000 }), s, ['missing_telemetry']).reasonCodes)
      .toContain('fault:missing_telemetry');
    expect(hardConstraints(of({ kind: 'continue' }), s, ['missing_telemetry']).allowed).toBe(true);
  });

  it('refuses an intervention the optimizer can no longer afford to decide', () => {
    const s = state({ resources: { ...state().resources, optimizationTokens: 100, optimizationConsumedTokens: 100 } });
    expect(hardConstraints(of({ orchestrationCost: 10 }), s).reasonCodes).toContain('optimization_budget_exhausted');
  });

  it('reports every constraint that fired, not just the first', () => {
    const e = evaluateAction(of({ qualityRisk: 0.9, tokenCost: 1e6, metadata: { unsafe: true } }), state());
    expect(e.reasonCodes).toEqual(expect.arrayContaining(['safety_violation', 'insufficient_budget', 'quality_floor']));
  });
});

describe('edge cases', () => {
  it('survives a candidate carrying non-finite numbers', () => {
    const e = evaluateAction(of({ tokenCost: Number.NaN, expectedTokenBenefit: Number.POSITIVE_INFINITY }), state());
    expect(Number.isFinite(e.expectedCostUsd)).toBe(true);
    expect(Number.isFinite(e.conservativeCostUsd)).toBe(true);
  });

  it('does not divide by a zero budget', () => {
    const s = state({ resources: { ...state().resources, totalTokenBudget: 0 } });
    expect(Number.isFinite(stateValue(s).tokens)).toBe(true);
    expect(stateValue(s).tokens).toBeGreaterThan(0);
  });

  it('never predicts a negative remaining cost, whatever the claimed saving', () => {
    const e = signalEstimate(of({ expectedTokenBenefit: 1e9 }), state());
    expect(e.expectedRemainingCost.tokens).toBeGreaterThanOrEqual(0);
  });
});
