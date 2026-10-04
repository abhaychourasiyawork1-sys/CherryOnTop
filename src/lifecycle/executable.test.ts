import { describe, expect, it } from 'vitest';
import { actionCandidate } from '../decision/actions.js';
import { chooseEconomicAction } from '../decision/engine.js';
import { initialEconomicState, normalizeEconomicState } from '../decision/state.js';
import { compose } from '../governor/contracts.js';
import { isExecutable } from './executable.js';

const state = normalizeEconomicState({
  ...initialEconomicState({ goal: 'g', totalTokenBudget: 200_000, validationRequired: true }),
  uncertainty: { target: 0.5, structural: 0.5, behavioral: 0.5, validation: 0.8 },
});
// A validation the market would buy on price, which production records but never carries out.
const validate = actionCandidate({ id: 'deep:validate', kind: 'validate', capability: 'validation.run',
  tokenCost: 100, expectedQualityBenefit: 0.8, expectedTokenBenefit: 50_000, confidence: 1 });
const read = actionCandidate({ id: 'evidence:a', kind: 'acquire_evidence', capability: 'evidence.read-file',
  tokenCost: 100, expectedTokenBenefit: 5_000, confidence: 1, metadata: { path: 'a.ts' } });
const advice = (id: string) => actionCandidate({ id, kind: 'acquire_evidence', capability: 'evidence.dependents', metadata: { advice: 'look first' } });

describe('isExecutable mirrors carryOut', () => {
  it('accepts what production carries out and nothing else', () => {
    expect(isExecutable(actionCandidate({ id: 'continue', kind: 'continue', capability: 'agent.continue' }))).toBe(true);
    expect(isExecutable(actionCandidate({ id: 'r', kind: 'recover', capability: 'recovery' }))).toBe(true);
    expect(isExecutable(read)).toBe(true);
    expect(isExecutable(advice('dormant:x'))).toBe(true);
    expect(isExecutable(validate)).toBe(false);
    expect(isExecutable(actionCandidate({ id: 'deep:constrain', kind: 'constrain', capability: 'c' }))).toBe(false);
    expect(isExecutable(actionCandidate({ id: 'h', kind: 'reuse_evidence', capability: 'evidence.store' }))).toBe(false);
    expect(isExecutable(compose(advice('a'), advice('b'), 'SEQ'))).toBe(true);
    expect(isExecutable(compose(advice('a'), read, 'SEQ'))).toBe(false);
  });
});

describe('the market refuses what cannot be carried out', () => {
  it('without the filter the unexecutable validation wins', () => {
    expect(chooseEconomicAction({ state, candidates: [validate, read] }).action.id).toBe('deep:validate');
  });

  it('with it, the next executable candidate wins and the refusal keeps its price and reason', () => {
    const d = chooseEconomicAction({ state, candidates: [validate, read], executable: isExecutable });
    expect(d.action.id).toBe('evidence:a');
    const refused = d.candidates!.find((c) => c.id === 'deep:validate')!;
    expect(refused.status).toBe('rejected');
    expect(refused.reasonCodes).toContain('unavailable:not_carried_out');
    expect(Number.isFinite(refused.expectedCostUsd)).toBe(true);
  });

  it('continue remains the fallback when nothing executable is left', () => {
    const d = chooseEconomicAction({ state, candidates: [validate], executable: isExecutable });
    expect(d.action.kind).toBe('continue');
  });
});
