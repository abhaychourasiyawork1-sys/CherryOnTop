import { describe, it, expect } from 'vitest';
import { actionCandidate } from '../decision/actions.js';
import { initialEconomicState, normalizeEconomicState, type EconomicState } from '../decision/state.js';
import {
  contractOf, unmetPreconditions, compatible, compose, composeCandidates, partsOf,
  COMPOSITION_TOP_K, MAX_COMPOSITION_DEPTH,
} from './contracts.js';

function state(over: Partial<EconomicState> = {}): EconomicState {
  return normalizeEconomicState({ ...initialEconomicState({ goal: 'g', totalTokenBudget: 50_000 }), ...over });
}

const readDesign = actionCandidate({
  id: 'read-design', kind: 'acquire_evidence', capability: 'evidence.read-file', tokenCost: 500,
  expectedInformationGain: 0.6, expectedTokenBenefit: 1_000, confidence: 0.8,
  metadata: { addresses: ['structural'], contract: { evidenceProduced: ['design'] } },
});
const validate = actionCandidate({
  id: 'validate', kind: 'validate', capability: 'validation.progressive', tokenCost: 2_000,
  expectedQualityBenefit: 0.4, confidence: 0.8,
  metadata: { addresses: ['validation'], contract: { evidenceConsumed: ['design'] } },
});
const reuse = actionCandidate({
  id: 'reuse', kind: 'reuse_evidence', capability: 'evidence.store', tokenCost: 100,
  expectedInformationGain: 0.5, expectedTokenBenefit: 800, confidence: 0.7, metadata: { addresses: ['structural'] },
});

describe('contracts', () => {
  it('credits information only to the dimensions the provider declared', () => {
    expect(contractOf(readDesign).uncertaintyEffects).toEqual({ structural: 0.6 });
    const undeclared = actionCandidate({ id: 'x', kind: 'explore', capability: 'x', expectedInformationGain: 0.9 });
    expect(contractOf(undeclared).uncertaintyEffects).toEqual({});
  });

  it('reads a quality claim as a claim about correctness doubt', () => {
    expect(contractOf(validate).uncertaintyEffects.validation).toBeCloseTo(0.4);
  });

  it('checks preconditions against the state without asking anyone', () => {
    const needsProgress = actionCandidate({ id: 'p', kind: 'validate', capability: 'v',
      metadata: { preconditions: [{ field: 'progress', op: '>=', value: 0.5 }] } });
    expect(unmetPreconditions(contractOf(needsProgress), state())).toHaveLength(1);
    const along = state({ trajectory: { ...state().trajectory, progress: 0.6 } });
    expect(unmetPreconditions(contractOf(needsProgress), along)).toHaveLength(0);
  });

  it('drops a malformed declaration rather than trusting it', () => {
    const junk = actionCandidate({ id: 'j', kind: 'validate', capability: 'v',
      metadata: { contract: { preconditions: [{ field: 'progress', op: 'nope', value: 'x' }], reversibility: 7 } } });
    const c = contractOf(junk);
    expect(c.preconditions).toEqual([]);
    expect(c.reversibility).toBe(1);
  });
});

describe('the bounded action algebra', () => {
  it('will not run side by side what one consumes from the other', () => {
    expect(compatible(readDesign, validate, 'PAR', state())).toBe(false);
    expect(compatible(readDesign, validate, 'SEQ', state())).toBe(true);
  });

  it('combines benefits by noisy-OR, never by addition', () => {
    const both = compose(readDesign, reuse, 'PAR');
    expect(both.expectedInformationGain).toBeLessThan(readDesign.expectedInformationGain + reuse.expectedInformationGain);
    expect(both.expectedInformationGain).toBeGreaterThan(Math.max(readDesign.expectedInformationGain, reuse.expectedInformationGain));
    // Same dimension: the second saving is the same ground.
    expect(both.expectedTokenBenefit).toBe(Math.max(readDesign.expectedTokenBenefit, reuse.expectedTokenBenefit));
  });

  it('stays transparent and decomposable, and never deeper than two', () => {
    const seq = compose(readDesign, validate, 'SEQ');
    expect(partsOf(seq).map((p) => p.id)).toEqual(['read-design', 'validate']);
    expect(compatible(seq, reuse, 'SEQ', state())).toBe(false);
    expect((seq.metadata.composite as { depth: number }).depth).toBe(MAX_COMPOSITION_DEPTH);
  });

  it('composes only the top K, and never builds what cannot beat the frontier even optimistically', () => {
    const many = Array.from({ length: 8 }, (_, i) => actionCandidate({
      id: `c${i}`, kind: 'acquire_evidence', capability: 'x', tokenCost: 10,
      expectedInformationGain: 0.3, metadata: { addresses: [i % 2 ? 'structural' : 'behavioral'] },
    }));
    const adv = (c: { id: string }) => Number(c.id.slice(1));
    const open = composeCandidates({ primitives: many, state: state(), advantage: adv, frontier: -Infinity });
    const k = COMPOSITION_TOP_K;
    expect(open.considered).toBe(k * (k - 1) + (k * (k - 1)) / 2);
    expect(open.composites.length).toBeLessThanOrEqual(open.considered);
    const closed = composeCandidates({ primitives: many, state: state(), advantage: adv, frontier: 1_000 });
    expect(closed.composites).toHaveLength(0);
    expect(closed.boundedOut).toBe(closed.considered);
  });

  it('never composes the null actions', () => {
    const cont = actionCandidate({ id: 'continue', kind: 'continue', capability: 'agent.continue' });
    const out = composeCandidates({ primitives: [cont, readDesign], state: state(), advantage: () => 1, frontier: -1 });
    expect(out.composites).toHaveLength(0);
  });
});
