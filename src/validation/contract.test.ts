import { describe, it, expect } from 'vitest';
import { detectionStrength, LEVEL_MODEL } from './contract.js';

describe('detectionStrength', () => {
  it('is the confidence of the cheapest level that clears the floor', () => {
    expect(detectionStrength(0.3)).toBe(LEVEL_MODEL.V1.confidence);
    expect(detectionStrength(0.7)).toBe(LEVEL_MODEL.V2.confidence);
    expect(detectionStrength(0.9)).toBe(LEVEL_MODEL.V3.confidence);
  });

  it('is the strongest available when the floor cannot be cleared, so the floor stays falsifiable', () => {
    expect(detectionStrength(1)).toBe(LEVEL_MODEL.V3.confidence);
    expect(detectionStrength(1)).toBeLessThan(1);
  });

  it('is total', () => {
    expect(detectionStrength(Number.NaN)).toBe(LEVEL_MODEL.V0.confidence);
  });
});
