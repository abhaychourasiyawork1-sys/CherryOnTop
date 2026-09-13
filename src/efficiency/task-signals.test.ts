import { describe, it, expect } from 'vitest';
import { normalizeTaskSignals, UNKNOWN_SIGNALS } from './task-signals.js';
import type { TaskEconomicsSignals } from './policy-types.js';

const NUMERIC: (keyof TaskEconomicsSignals)[] = [
  'confidence', 'breadth', 'expectedModificationScope', 'investigationLikelihood', 'verificationNeed',
];

describe('normalizeTaskSignals', () => {
  it('leaves an already-normalized signal set alone', () => {
    const signals: TaskEconomicsSignals = {
      confidence: 0.8, breadth: 0.2, hasExplicitAnchors: true, expectedModificationScope: 0.1,
      investigationLikelihood: 0.05, verificationNeed: 0.6, readOnly: false, complexityBand: 'small',
    };
    expect(normalizeTaskSignals(signals)).toEqual(signals);
  });

  it('clamps every numeric signal into [0,1]', () => {
    const wild = normalizeTaskSignals({
      confidence: 12, breadth: -4, expectedModificationScope: 99,
      investigationLikelihood: -0.5, verificationNeed: Number.MAX_VALUE,
    });
    for (const key of NUMERIC) {
      const value = wild[key] as number;
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('answers a missing or non-finite signal with the neutral middle, not an extreme', () => {
    const s = normalizeTaskSignals({ confidence: NaN, breadth: undefined });
    expect(s.confidence).toBe(UNKNOWN_SIGNALS.confidence);
    expect(s.breadth).toBe(UNKNOWN_SIGNALS.breadth);
    expect(s.confidence).toBeGreaterThan(0);
    expect(s.confidence).toBeLessThan(1);
  });

  it('keeps booleans boolean and defaults them to the cautious side', () => {
    const s = normalizeTaskSignals({});
    expect(s.hasExplicitAnchors).toBe(false);
    // "We do not know" must not be read as "nothing will be written".
    expect(s.readOnly).toBe(false);
    expect(normalizeTaskSignals({ readOnly: true }).readOnly).toBe(true);
  });

  it('refuses a complexity band it does not recognise', () => {
    const s = normalizeTaskSignals({ complexityBand: 'enormous' as TaskEconomicsSignals['complexityBand'] });
    expect(s.complexityBand).toBe('unknown');
  });

  it('is idempotent — normalizing twice changes nothing', () => {
    const once = normalizeTaskSignals({ confidence: 3, breadth: -1, complexityBand: 'large' });
    expect(normalizeTaskSignals(once)).toEqual(once);
  });
});
