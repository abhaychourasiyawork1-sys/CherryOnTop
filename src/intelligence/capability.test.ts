import { describe, it, expect } from 'vitest';
import {
  fitCapability, successProbability, CAPABILITY_PRIOR_MEAN, type CapabilityObservation, type CandidateIdentity,
} from './capability.js';

const id = (name: string, facts: Record<string, number> = {}): CandidateIdentity =>
  ({ modelKey: `m:${name}`, candidateKey: `c:${name}`, facts });

function outcomes(name: string, difficulty: number, passes: number, fails: number, facts = {}): CapabilityObservation[] {
  const row = (validated: boolean): CapabilityObservation =>
    ({ modelKey: `m:${name}`, candidateKey: `c:${name}`, facts, difficulty, validated, weight: 1 });
  return [
    ...Array.from({ length: passes }, () => row(true)),
    ...Array.from({ length: fails }, () => row(false)),
  ];
}

describe('successProbability', () => {
  it('is 0.5 when capability equals difficulty and rises with the margin', () => {
    expect(successProbability(0.5, 0.5)).toBeCloseTo(0.5);
    expect(successProbability(0.9, 0.5)).toBeGreaterThan(successProbability(0.6, 0.5));
    expect(successProbability(0.2, 0.9)).toBeLessThan(0.05);
  });
});

describe('with no evidence', () => {
  it('every candidate is the same unknown: prior mean, wide, nothing ranked', () => {
    const model = fitCapability([]);
    const a = model.believe(id('a', { price: 1 }));
    const b = model.believe(id('b', { price: 50 }));
    expect(a.mean).toBeCloseTo(CAPABILITY_PRIOR_MEAN);
    expect(b.mean).toBeCloseTo(a.mean);
    expect(a.sd).toBeGreaterThan(0.3);
    expect(a.observations).toBe(0);
  });
});

describe('learning from validated outcomes', () => {
  it('learns a candidate that passes hard work is capable, and one that fails easy work is not', () => {
    const model = fitCapability([...outcomes('strong', 0.8, 12, 0), ...outcomes('weak', 0.2, 1, 11)]);
    const strong = model.believe(id('strong'));
    const weak = model.believe(id('weak'));
    expect(strong.mean).toBeGreaterThan(weak.mean + 0.3);
    expect(strong.sd).toBeLessThan(0.5);
  });

  it('does not read easy successes as proof it can do hard work', () => {
    const model = fitCapability(outcomes('a', 0.1, 30, 0));
    const belief = model.believe(id('a'));
    expect(successProbability(belief.mean, 0.9)).toBeLessThan(0.5);
    expect(successProbability(belief.mean, 0.1)).toBeGreaterThan(0.5);
  });

  it('narrows with evidence', () => {
    const few = fitCapability(outcomes('a', 0.5, 2, 2)).believe(id('a'));
    const many = fitCapability(outcomes('a', 0.5, 20, 20)).believe(id('a'));
    expect(many.sd).toBeLessThan(few.sd);
    expect(many.observations).toBe(40);
  });

  it('ignores unknown labels (weight 0) entirely', () => {
    const unknown = outcomes('a', 0.5, 10, 0).map((o) => ({ ...o, weight: 0 }));
    const model = fitCapability(unknown);
    expect(model.believe(id('a')).mean).toBeCloseTo(CAPABILITY_PRIOR_MEAN);
    expect(model.believe(id('a')).observations).toBe(0);
  });

  it('shares evidence across efforts of one model, but lets an effort differ', () => {
    const lowOnly = outcomes('x', 0.7, 10, 0).map((o) => ({ ...o, modelKey: 'm:shared', candidateKey: 'c:shared:low' }));
    const model = fitCapability(lowOnly);
    const sibling = model.believe({ modelKey: 'm:shared', candidateKey: 'c:shared:max', facts: {} });
    const stranger = model.believe({ modelKey: 'm:other', candidateKey: 'c:other', facts: {} });
    const seen = model.believe({ modelKey: 'm:shared', candidateKey: 'c:shared:low', facts: {} });
    expect(sibling.mean).toBeGreaterThan(stranger.mean);
    expect(sibling.mean).toBeLessThanOrEqual(seen.mean + 1e-9);
  });
});

describe('features are opaque numeric facts whose weight is learned', () => {
  it('a fact that predicts capability lets an unseen candidate borrow strength; one that does not is ignored', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    // "size" tracks capability: bigger candidates pass hard work.
    const predictive = names.flatMap((n, i) => outcomes(n, 0.7, i >= 3 ? 8 : 0, i >= 3 ? 0 : 8, { size: i }));
    const model = fitCapability(predictive);
    const small = model.believe(id('new-small', { size: 0 }));
    const big = model.believe(id('new-big', { size: 5 }));
    expect(big.mean).toBeGreaterThan(small.mean);

    // "noise" is unrelated to outcomes: two candidates differing only in noise are not separated.
    const irrelevant = names.flatMap((n, i) => outcomes(n, 0.5, 4, 4, { noise: i * 7 }));
    const m2 = fitCapability(irrelevant);
    const lo = m2.believe(id('u1', { noise: 0 }));
    const hi = m2.believe(id('u2', { noise: 40 }));
    expect(Math.abs(hi.mean - lo.mean)).toBeLessThan(0.05);
  });
});

describe('relabeling', () => {
  it('does not depend on what a candidate is called or the order observations arrive in', () => {
    const obs = [...outcomes('p', 0.8, 9, 1), ...outcomes('q', 0.3, 2, 8)];
    const renamed = obs.map((o) => ({ ...o, modelKey: o.modelKey.replace('m:', 'z:'), candidateKey: o.candidateKey.replace('c:', 'y:') }));
    const a = fitCapability(obs).believe(id('p'));
    const b = fitCapability([...renamed].reverse()).believe({ modelKey: 'z:p', candidateKey: 'y:p', facts: {} });
    expect(b.mean).toBeCloseTo(a.mean, 6);
    expect(b.sd).toBeCloseTo(a.sd, 6);
  });
});
