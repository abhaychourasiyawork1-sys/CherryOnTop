import { describe, it, expect } from 'vitest';
import {
  updateUncertainty, uncertaintyValue, totalUncertaintyValue,
  UNCERTAINTY_KINDS, DEFAULT_EVIDENCE_MODEL,
  type UncertaintyObservation,
} from './uncertainty.js';
import type { UncertaintyState } from './state.js';

const full: UncertaintyState = { target: 1, structural: 1, behavioral: 1, validation: 1 };
const half: UncertaintyState = { target: 0.5, structural: 0.5, behavioral: 0.5, validation: 0.5 };

const observed = (over: Partial<UncertaintyObservation> = {}): UncertaintyObservation => ({
  kind: 'structural', before: 0.5, after: 0.2, sourceEvidenceIds: ['e1'], confidence: 1, ...over,
});

describe('the dimensions are independent', () => {
  it('lets structural evidence move structural doubt and nothing else', () => {
    const next = updateUncertainty(half, [observed({ kind: 'structural', after: 0.1 })]);
    expect(next.structural).toBeLessThan(half.structural);
    expect(next.behavioral).toBe(half.behavioral);
    expect(next.target).toBe(half.target);
    expect(next.validation).toBe(half.validation);
  });

  it('moves each dimension named, and only those', () => {
    const next = updateUncertainty(half, [
      observed({ kind: 'target', after: 0.1, sourceEvidenceIds: ['a'] }),
      observed({ kind: 'validation', after: 0.2, sourceEvidenceIds: ['b'] }),
    ]);
    expect(next.target).toBeCloseTo(0.1);
    expect(next.validation).toBeCloseTo(0.2);
    expect(next.structural).toBe(0.5);
    expect(next.behavioral).toBe(0.5);
  });

  it('ignores an observation about a dimension that does not exist', () => {
    const next = updateUncertainty(half, [observed({ kind: 'vibes' as never })]);
    expect(next).toEqual(half);
  });

  it('returns a new value and never mutates the one it was given', () => {
    const before = { ...half };
    updateUncertainty(half, [observed()]);
    expect(half).toEqual(before);
  });
});

describe('updates are bounded and believed in proportion', () => {
  it('never drives doubt below zero or above one', () => {
    expect(updateUncertainty(half, [observed({ after: -5 })]).structural).toBe(0);
    expect(updateUncertainty(half, [observed({ after: 9 })]).structural).toBe(1);
  });

  it('moves all the way to what was observed when fully confident', () => {
    expect(updateUncertainty(half, [observed({ after: 0.2, confidence: 1 })]).structural).toBeCloseTo(0.2);
  });

  it('moves part way when the observer is unsure, and never past the observation', () => {
    const partial = updateUncertainty(half, [observed({ after: 0.2, confidence: 0.5 })]).structural;
    expect(partial).toBeGreaterThan(0.2);
    expect(partial).toBeLessThan(0.5);
  });

  it('does nothing at all when the observer has no confidence', () => {
    expect(updateUncertainty(half, [observed({ confidence: 0 })]).structural).toBe(0.5);
  });

  it('lets evidence raise doubt as well as lower it', () => {
    expect(updateUncertainty(half, [observed({ after: 0.9 })]).structural).toBeCloseTo(0.9);
  });

  it('discounts an observation whose premise no longer holds', () => {
    // Both claim the doubt lands at 0.2. One was computed against the doubt we
    // actually hold; the other against a state three events stale.
    const current = updateUncertainty(half, [observed({ before: 0.5, after: 0.2 })]).structural;
    const stale = updateUncertainty(half, [observed({ before: 1, after: 0.2 })]).structural;
    expect(stale).toBeGreaterThan(current);
  });
});

describe('repeated evidence does not manufacture confidence', () => {
  it('applies the same observation once within a single call', () => {
    const once = updateUncertainty(half, [observed({ after: 0.2, confidence: 0.5 })]).structural;
    const twice = updateUncertainty(half, [
      observed({ after: 0.2, confidence: 0.5 }),
      observed({ after: 0.2, confidence: 0.5 }),
    ]).structural;
    expect(twice).toBeCloseTo(once);
  });

  it('skips an observation whose evidence has already been counted', () => {
    const next = updateUncertainty(half, [observed({ sourceEvidenceIds: ['e1'] })], ['e1']);
    expect(next).toEqual(half);
  });

  it('still applies an observation that brings any new evidence with it', () => {
    const next = updateUncertainty(half, [observed({ sourceEvidenceIds: ['e1', 'e2'] })], ['e1']);
    expect(next.structural).toBeLessThan(half.structural);
  });

  it('treats one piece of evidence about two dimensions as two observations', () => {
    const next = updateUncertainty(half, [
      observed({ kind: 'structural', after: 0.2, sourceEvidenceIds: ['e1'] }),
      observed({ kind: 'behavioral', after: 0.3, sourceEvidenceIds: ['e1'] }),
    ]);
    expect(next.structural).toBeCloseTo(0.2);
    expect(next.behavioral).toBeCloseTo(0.3);
  });

  it('cannot be walked to certainty by repeating one read', () => {
    let state = { ...full };
    for (let i = 0; i < 20; i++) {
      state = updateUncertainty(state, [observed({ kind: 'structural', before: state.structural, after: 0.6, sourceEvidenceIds: ['same'] })], ['same']);
    }
    expect(state.structural).toBe(1);
  });
});

describe('the value of removing doubt has diminishing returns', () => {
  it('prices a large reduction at high doubt above the linear multiple of a small one at low doubt', () => {
    const big = uncertaintyValue(0.8, 0.5);
    const small = uncertaintyValue(0.2, 0.1);
    // Linearly these would be 0.3 and 0.1 — exactly 3x. The configured evidence
    // model says high doubt is disproportionately costly, so it must not be 3x.
    expect(big / small).toBeGreaterThan(3);
  });

  it('is linear when the model says it is', () => {
    const linear = { curvature: 1 };
    expect(uncertaintyValue(0.8, 0.5, linear)).toBeCloseTo(0.3);
    expect(uncertaintyValue(0.2, 0.1, linear)).toBeCloseTo(0.1);
  });

  it('prices evidence that removed no doubt at zero', () => {
    expect(uncertaintyValue(0.5, 0.5)).toBe(0);
    expect(uncertaintyValue(0.5, 0.9)).toBe(0);
  });

  it('is monotonic in how much doubt was removed', () => {
    expect(uncertaintyValue(0.9, 0.1)).toBeGreaterThan(uncertaintyValue(0.9, 0.5));
  });

  it('survives a nonsense curvature rather than returning NaN', () => {
    expect(Number.isFinite(uncertaintyValue(0.8, 0.2, { curvature: Number.NaN }))).toBe(true);
    expect(Number.isFinite(uncertaintyValue(0.8, 0.2, { curvature: -1 }))).toBe(true);
  });

  it('sums across dimensions so two different cures are comparable', () => {
    const structuralOnly = { ...half, structural: 0.1 };
    const spreadThin = { target: 0.4, structural: 0.4, behavioral: 0.4, validation: 0.4 };
    expect(totalUncertaintyValue(half, structuralOnly)).toBeGreaterThan(0);
    expect(totalUncertaintyValue(half, spreadThin)).toBeGreaterThan(0);
    expect(totalUncertaintyValue(half, half)).toBe(0);
  });

  it('uses a curvature above 1 by default', () => {
    expect(DEFAULT_EVIDENCE_MODEL.curvature).toBeGreaterThan(1);
  });
});

describe('UNCERTAINTY_KINDS', () => {
  it('names exactly the four dimensions the state carries', () => {
    expect([...UNCERTAINTY_KINDS].sort()).toEqual(['behavioral', 'structural', 'target', 'validation']);
  });
});
