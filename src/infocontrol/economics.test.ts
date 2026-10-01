import { describe, it, expect } from 'vitest';
import { betaProbability, carryingUsd, elisionValue, expectedRemainingTurns, refetchBound, refetchMean, refetchUsd } from './economics.js';
import { perTokenRates } from '../execution/pricing.js';

const haiku = perTokenRates('haiku');

describe('carrying cost', () => {
  it('prices a token as one cache write plus a cache read per remaining turn', () => {
    // Haiku: $2/M write (1h cache), $0.10/M read.
    expect(carryingUsd(1_000_000, 0, haiku)).toBeCloseTo(2);
    expect(carryingUsd(1_000_000, 10, haiku)).toBeCloseTo(3);
  });

  it('is never negative', () => {
    expect(carryingUsd(-5, 3, haiku)).toBe(0);
    expect(carryingUsd(100, -3, haiku)).toBeCloseTo(100 * haiku.write);
  });
});

describe('expectedRemainingTurns', () => {
  it('with no history expects as many turns again as have passed (scale-free prior)', () => {
    expect(expectedRemainingTurns(12, [])).toBe(12);
    expect(expectedRemainingTurns(0, [])).toBe(1);
  });

  it('moves toward the mean residual of past dispatches that lasted longer', () => {
    const many = Array.from({ length: 200 }, () => 50);
    expect(expectedRemainingTurns(10, many)).toBeGreaterThan(35);
    expect(expectedRemainingTurns(10, many)).toBeLessThan(40);
  });

  it('ignores dispatches that ended before this step', () => {
    expect(expectedRemainingTurns(30, [5, 10, 20])).toBe(30);
  });
});

describe('refetch belief', () => {
  it('is uniform with no evidence and tightens with it', () => {
    expect(refetchMean({ refetched: 0, elided: 0 })).toBe(0.5);
    const few = refetchBound({ refetched: 1, elided: 10 }, 0.9);
    const many = refetchBound({ refetched: 10, elided: 100 }, 0.9);
    expect(many).toBeLessThan(few);
    expect(many).toBeGreaterThan(0.1);
  });
});

describe('elisionValue', () => {
  const base = {
    remainingTurns: 20,
    refetch: { contextTokens: 40_000, outputPerTurn: 200, sliceTokens: 3000, remainingTurns: 20 },
  };

  it('elides a large log that is rarely refetched', () => {
    const v = elisionValue({ ...base, elidedTokens: 8000, probability: betaProbability({ refetched: 2, elided: 100 }, 0.9) }, haiku);
    expect(v.verdict).toBe('elide');
    expect(v.savedUsd).toBeGreaterThan(v.riskBoundUsd);
  });

  it('keeps a small output whose refetch would cost more than carrying it', () => {
    const v = elisionValue({ ...base, elidedTokens: 150, probability: betaProbability({ refetched: 50, elided: 100 }, 0.9) }, haiku);
    expect(v.verdict).toBe('keep');
  });

  it('calls it ambiguous when only the pessimistic bound says keep', () => {
    // Saved = 1500·(2e-6 + 20·1e-7) = 0.006. A refetch re-reads 40k (0.004),
    // writes 200 out (0.001) and carries the 1500 back (0.00585) = 0.01085.
    // At the uniform mean (0.5) that is 0.0054 < saved; at the bound it is not.
    const v = elisionValue({
      ...base, elidedTokens: 1500, probability: betaProbability({ refetched: 0, elided: 0 }, 0.9),
      refetch: { ...base.refetch, sliceTokens: 1500 },
    }, haiku);
    expect(v.verdict).toBe('ambiguous');
  });

  it('a refetch costs a full context re-read plus carrying the slice', () => {
    const c = refetchUsd({ contextTokens: 10_000, outputPerTurn: 0, sliceTokens: 0, remainingTurns: 5 }, haiku);
    expect(c).toBeCloseTo(10_000 * haiku.read);
  });
});
