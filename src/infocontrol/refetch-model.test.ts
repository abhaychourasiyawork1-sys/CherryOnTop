import { describe, it, expect } from 'vitest';
import { featurize, fitRefetchModel, predictRefetch, type RefetchFeatures } from './refetch-model.js';

const base: RefetchFeatures = { tool: 'read', representation: 'salient', originalTokens: 4000, keptFraction: 0.2, novelIdentifiers: 0, progress: 0.5 };

/** A deterministic pseudo-random stream, so the test never flakes. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('fitRefetchModel', () => {
  it('returns null with no evidence (the caller falls back to the Beta)', () => {
    expect(fitRefetchModel([])).toBeNull();
  });

  it('learns that elisions hiding many novel identifiers come back', () => {
    const r = rng(7);
    const rows = Array.from({ length: 2000 }, () => {
      const novel = Math.floor(r() * 40);
      const p = 1 / (1 + Math.exp(-(-2.5 + 0.15 * novel)));
      return { features: { ...base, novelIdentifiers: novel }, used: r() < p };
    });
    const model = fitRefetchModel(rows)!;
    const low = predictRefetch(model, { ...base, novelIdentifiers: 0 }, 0.9);
    const high = predictRefetch(model, { ...base, novelIdentifiers: 35 }, 0.9);
    expect(low.mean).toBeLessThan(0.15);
    expect(high.mean).toBeGreaterThan(0.85);
  });

  it('is calibrated on its own distribution', () => {
    const r = rng(11);
    const rows = Array.from({ length: 3000 }, () => {
      const kept = r();
      const p = 0.1 + 0.6 * (1 - kept);
      return { features: { ...base, keptFraction: kept }, used: r() < p };
    });
    const model = fitRefetchModel(rows)!;
    const bins = [0, 0, 0, 0, 0].map(() => ({ p: 0, y: 0, n: 0 }));
    for (const row of rows) {
      const p = predictRefetch(model, row.features, 0.5).mean;
      const b = bins[Math.min(4, Math.floor(p * 5))];
      b.p += p; b.y += row.used ? 1 : 0; b.n++;
    }
    for (const b of bins.filter((x) => x.n > 100)) expect(Math.abs(b.p / b.n - b.y / b.n)).toBeLessThan(0.06);
  });

  it('is more cautious where the evidence is thin', () => {
    const few = fitRefetchModel(Array.from({ length: 10 }, (_, i) => ({ features: base, used: i < 2 })))!;
    const many = fitRefetchModel(Array.from({ length: 1000 }, (_, i) => ({ features: base, used: i < 200 })))!;
    const gap = (m: typeof few) => { const p = predictRefetch(m, base, 0.9); return p.bound - p.mean; };
    expect(gap(few)).toBeGreaterThan(gap(many));
    expect(predictRefetch(many, base, 0.9).bound).toBeGreaterThanOrEqual(predictRefetch(many, base, 0.9).mean);
  });

  it('featurizes unknown tools and representations to zero indicators, never throws', () => {
    const x = featurize({ ...base, tool: 'webfetch', representation: 'full' });
    expect(x.every(Number.isFinite)).toBe(true);
  });
});
