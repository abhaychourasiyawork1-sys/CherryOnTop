import { describe, expect, it } from 'vitest';
import { actionCandidate } from './actions.js';
import { chooseEconomicAction, type UnmaskedMenu } from './engine.js';
import { initialEconomicState, normalizeEconomicState } from './state.js';

const state = normalizeEconomicState({
  ...initialEconomicState({ goal: 'g', totalTokenBudget: 200_000, validationRequired: true }),
  uncertainty: { target: 0.5, structural: 0.5, behavioral: 0.5, validation: 0.8 },
  trajectory: { progress: 0.2, informationGain: 0, explorationPressure: 0, failurePressure: 0.5, stateSimilarity: 0, orchestrationConfidence: 0.6 },
});
const recover = actionCandidate({ id: 'recovery:retry', kind: 'recover', capability: 'recovery', tokenCost: 100, expectedTokenBenefit: 60_000, expectedProgress: 0.5, confidence: 1 });
const read = actionCandidate({ id: 'evidence:a', kind: 'acquire_evidence', capability: 'evidence.read-file', tokenCost: 100, expectedTokenBenefit: 5_000, confidence: 1, metadata: { path: 'a.ts' } });

describe('the experiment mask hook', () => {
  it('without a hook the market is unchanged', () => {
    const a = chooseEconomicAction({ state, candidates: [recover, read], decisionId: 'd' });
    const b = chooseEconomicAction({ state, candidates: [recover, read], decisionId: 'd', experimentMask: () => null });
    expect(b.action.id).toBe(a.action.id);
    expect(b.candidates).toEqual(a.candidates);
  });

  it('sees the unmasked priced menu once, in the market\'s own order', () => {
    const seen: UnmaskedMenu[] = [];
    const d = chooseEconomicAction({ state, candidates: [recover, read], experimentMask: (m) => { seen.push(m); return null; } });
    expect(seen).toHaveLength(1);
    expect(seen[0].feasibleInOrder[0].candidate.id).toBe(d.action.id);
    expect(seen[0].entries.map((e) => e.candidate.id).sort()).toEqual(['continue', 'evidence:a', 'recovery:retry']);
  });

  it('a refused candidate keeps its price, is rejected with the reason, and the market chooses among the rest', () => {
    const unmasked = chooseEconomicAction({ state, candidates: [recover, read] });
    expect(unmasked.action.id).toBe('recovery:retry');
    const d = chooseEconomicAction({ state, candidates: [recover, read], experimentMask: () => ({ refuse: ['recovery:retry'], reason: 'experiment:masked' }) });
    expect(d.action.id).not.toBe('recovery:retry');
    const snap = d.candidates!.find((c) => c.id === 'recovery:retry')!;
    expect(snap.status).toBe('rejected');
    expect(snap.reasonCodes).toContain('unavailable:experiment:masked');
    expect(snap.expectedCostUsd).toBe(unmasked.candidates!.find((c) => c.id === 'recovery:retry')!.expectedCostUsd);
  });

  it('can never refuse continue, nor add or force a candidate', () => {
    const d = chooseEconomicAction({ state, candidates: [], experimentMask: () => ({ refuse: ['continue', 'ghost'], reason: 'x' }) });
    expect(d.action.kind).toBe('continue');
    expect(d.candidates!.map((c) => c.id)).toEqual(['continue']);
  });
});
