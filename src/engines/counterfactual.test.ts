import { describe, it, expect } from 'vitest';
import { counterfactual } from './economics.js';

const full = {
  estimatedValue: 0.7, modelCost: 0.1, latencyCost: 0.05,
  coordinationCost: 0.15, verificationCost: 0.1, riskPenalty: 0,
  threshold: 0.3,
};

describe('counterfactual', () => {
  it('names how far a delegation sat from the line, and what would have stopped it', () => {
    const result = counterfactual({ ...full, score: 0.42 })!;
    expect(result.margin).toBeCloseTo(0.12);
    expect(result.direction).toBe('higher');
    expect(result.wouldHave).toBe('done it itself');
    // The largest cost term has the most room to move.
    expect(result.term).toBe('coordinationCost');
  });

  it('flips the sentence for a decision that did not delegate', () => {
    const result = counterfactual({ ...full, score: 0.1 })!;
    expect(result.direction).toBe('lower');
    expect(result.wouldHave).toBe('delegated');
  });

  it('never suggests lowering a term that is already zero', () => {
    const result = counterfactual({ ...full, riskPenalty: 0, score: 0.1 })!;
    expect(result.term).not.toBe('riskPenalty');
  });

  it('refuses to invent arithmetic for a rule-based outcome', () => {
    // decideExecution returns this shape when a node has no spawn authority —
    // there is a score, but no formula was ever run.
    expect(counterfactual({ score: 0, reason_no_spawn_authority: 1 })).toBeNull();
  });

  it('returns nothing for a decision recorded before economics existed', () => {
    expect(counterfactual({})).toBeNull();
    expect(counterfactual({ score: 1 })).toBeNull();
  });
});
