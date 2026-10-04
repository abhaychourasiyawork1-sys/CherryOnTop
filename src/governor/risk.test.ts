import { describe, it, expect } from 'vitest';
import { actionCandidate } from '../decision/actions.js';
import { initialEconomicState, normalizeEconomicState, type EconomicState } from '../decision/state.js';
import { stateValue, signalEstimate } from '../decision/utility.js';
import { chooseEconomicAction } from '../decision/engine.js';
import {
  riskSnapshot, riskStateValue, riskReduction, riskAwareEstimate, riskValuation, preventionValue,
  commitmentGradient, failureAt,
} from './risk.js';

function state(over: Partial<EconomicState> = {}): EconomicState {
  const base = initialEconomicState({ goal: 'g', totalTokenBudget: 100_000 });
  return normalizeEconomicState({
    ...base,
    version: 10,
    uncertainty: { target: 0.2, structural: 0.6, behavioral: 0.4, validation: 0.8 },
    trajectory: { ...base.trajectory, progress: 0.5, orchestrationConfidence: 0.9, failurePressure: 0.1 },
    ...over,
  });
}

const read = actionCandidate({
  id: 'read', kind: 'acquire_evidence', capability: 'evidence.read-file', tokenCost: 500,
  expectedInformationGain: 0.8, confidence: 0.9, metadata: { addresses: ['structural'] },
});
const check = actionCandidate({
  id: 'check', kind: 'validate', capability: 'validation.progressive', tokenCost: 2_000,
  expectedInformationGain: 0.9, confidence: 0.9, metadata: { addresses: ['validation'] },
});

describe('the risk snapshot', () => {
  it('reproduces V(s) exactly when risk is not moving — one loss channel, no second answer', () => {
    const s = state();
    const risk = riskSnapshot(s);
    expect(risk.failureVelocity).toBe(0);
    expect(riskStateValue(s, risk).tokens).toBeCloseTo(stateValue(s).tokens, 6);
  });

  it('measures velocity as a difference between two boundaries', () => {
    const before = riskSnapshot(state());
    const worse = state({ version: 12, trajectory: { ...state().trajectory, failurePressure: 0.5 } });
    const after = riskSnapshot(worse, before);
    expect(after.failureVelocity).toBeGreaterThan(0);
    expect(failureAt(after, 8)).toBeGreaterThan(after.immediateFailureProbability);
    expect(after.shortHorizonFailureProbability).toHaveLength(4);
  });

  it('carries no exposure on a validated task', () => {
    const done = state({ validation: { required: true, confidence: 1, status: 'passed' } });
    expect(riskSnapshot(done).riskExposure).toBe(0);
  });
});

describe('pricing loss avoided without double counting', () => {
  it('credits structural evidence only with the structural share of exposure', () => {
    const risk = riskSnapshot(state());
    const structural = riskReduction(read, risk);
    const validation = riskReduction(check, risk);
    expect(structural).toBeGreaterThan(0);
    // A read cannot be priced as if it proved the work correct.
    expect(structural).toBeLessThan(validation);
  });

  it('takes the larger of contract and claim — never their sum', () => {
    const s = state();
    const risk = riskSnapshot(s);
    const claimOnly = actionCandidate({ ...check, id: 'claim', metadata: {}, expectedInformationGain: 0, expectedQualityBenefit: 0.5 });
    const both = actionCandidate({ ...check, id: 'both', expectedQualityBenefit: 0.5 });
    const value = (c: typeof check) => riskAwareEstimate(c, s, risk).expectedRemainingCost.tokens;
    const contractOnly = value(check);
    expect(value(both)).toBeCloseTo(Math.min(contractOnly, value(claimOnly)), 6);
  });

  it('prices continue at V_r(s), so its advantage is zero and an intervention has to earn its place', () => {
    const s = state();
    const risk = riskSnapshot(s);
    const valuation = riskValuation(s, risk);
    const decision = chooseEconomicAction({ state: s, candidates: [], valuation });
    expect(decision.action.kind).toBe('continue');
    expect(decision.utility).toBeCloseTo(0, 9);
  });

  it('labels its estimates as signal', () => {
    const s = state();
    expect(riskAwareEstimate(read, s, riskSnapshot(s)).provenance).toBe('signal');
  });

  it('raises the value of looking before committing, and only for information', () => {
    const s = state();
    expect(commitmentGradient(s, read, 4)).toBeLessThan(0);
    const work = actionCandidate({ id: 'work', kind: 'continue', capability: 'x', expectedProgress: 0.5 });
    expect(commitmentGradient(s, work, 4)).toBeGreaterThanOrEqual(0);
    const risk = riskSnapshot(s);
    const withOption = riskAwareEstimate(read, s, risk, { horizon: 4 }).expectedRemainingCost.tokens;
    const without = riskAwareEstimate(read, s, risk, { horizon: 4, optionValue: false }).expectedRemainingCost.tokens;
    expect(withOption).toBeLessThanOrEqual(without);
  });

  it('cannot buy past the quality floor or a hard constraint with risk savings', () => {
    const s = state();
    const valuation = riskValuation(s, riskSnapshot(s));
    const unsafe = actionCandidate({ ...check, id: 'unsafe', metadata: { ...check.metadata, unsafe: true } });
    const decision = chooseEconomicAction({ state: s, candidates: [unsafe], valuation });
    expect(decision.action.id).not.toBe('unsafe');
    expect(decision.rejected?.find((r) => r.id === 'unsafe')?.reasonCodes).toContain('safety_violation');
  });
});

describe('the prevention frontier', () => {
  it('is too late once the failure it would prevent has been observed', () => {
    const s = state({ validation: { required: true, confidence: 1, status: 'failed' } });
    expect(preventionValue(check, s, riskSnapshot(s)).timing).toBe('too_late');
  });

  it('is not justified when there is nothing to lose', () => {
    const s = state({ uncertainty: { target: 0, structural: 0, behavioral: 0, validation: 0 },
      trajectory: { ...state().trajectory, failurePressure: 0 } });
    expect(preventionValue(check, s, riskSnapshot(s)).timing).toBe('not_justified');
  });

  it('grows with rising risk rather than at a fixed threshold', () => {
    const s = state();
    const flat = riskSnapshot(s);
    const rising = riskSnapshot(state({ version: 11, trajectory: { ...s.trajectory, failurePressure: 0.4 } }), flat);
    const calm = preventionValue(check, s, flat, 4);
    const hot = preventionValue(check, s, rising, 4);
    expect(hot.valueNow).toBeGreaterThan(calm.valueNow);
  });

  it('differs from the plain signal estimate only through the loss term', () => {
    // A candidate with no contract and no claims prices the same either way.
    const s = state();
    const inert = actionCandidate({ id: 'inert', kind: 'explore', capability: 'x', tokenCost: 100, confidence: 1 });
    expect(riskAwareEstimate(inert, s, riskSnapshot(s)).expectedRemainingCost.tokens)
      .toBeCloseTo(signalEstimate(inert, s).expectedRemainingCost.tokens, 6);
  });
});
