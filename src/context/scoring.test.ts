import { describe, it, expect } from 'vitest';
import { contributions, createContextScorer, explorationAvoided, marginalValue, DEFAULT_SCORE_WEIGHTS } from './scoring.js';
import type { ContextCandidate } from './candidates.js';

const candidate = (over: Partial<ContextCandidate> = {}): ContextCandidate => ({
  key: 'src/a.ts', path: 'src/a.ts', symbols: [], evidenceLevel: 'L1', estimatedTokens: 20,
  lexicalScore: 0, structuralScore: 0, taskFitScore: 0.5, confidenceScore: 0,
  reuseScore: 0, relationships: [], materialization: 'inventory', ...over,
});

const score = (c: ContextCandidate) => createContextScorer().score(c, DEFAULT_SCORE_WEIGHTS);

describe('explorationAvoided', () => {
  it('credits an anchored file almost nothing — the agent was opening it anyway', () => {
    expect(explorationAvoided(candidate({ relationships: ['anchor'], structuralScore: 1, confidenceScore: 1 })))
      .toBeLessThan(0.2);
  });

  it('credits a structural neighbour the agent would have had to hunt for', () => {
    expect(explorationAvoided(candidate({ relationships: ['imports:src/b.ts'], structuralScore: 1, confidenceScore: 0.7 })))
      .toBeGreaterThan(0.5);
  });

  it('credits a test relationship above a plain import edge', () => {
    const test = candidate({ relationships: ['test-of:src/b.ts'], structuralScore: 0.5, confidenceScore: 0.7 });
    const plain = candidate({ relationships: ['imports:src/b.ts'], structuralScore: 0.5, confidenceScore: 0.7 });
    expect(explorationAvoided(test)).toBeGreaterThan(explorationAvoided(plain));
  });

  it('stays inside [0,1] however strong the evidence', () => {
    const v = explorationAvoided(candidate({
      relationships: ['test-of:x', 'imports:y', 'imported-by:z'], structuralScore: 1, confidenceScore: 1,
    }));
    expect(v).toBeLessThanOrEqual(1);
    expect(v).toBeGreaterThanOrEqual(0);
  });
});

describe('contributions', () => {
  it('reports every term separately so a selection can be read', () => {
    const c = contributions(candidate({ lexicalScore: 4, confidenceScore: 1 }));
    expect(Object.keys(c)).toEqual(expect.arrayContaining([
      'anchorRelevance', 'structuralRelevance', 'taskFit', 'confidence',
      'expectedExplorationAvoided', 'reuseValue', 'contextCost', 'total',
    ]));
  });

  it('charges cost against the total rather than adding it', () => {
    const cheap = contributions(candidate({ lexicalScore: 4, estimatedTokens: 10 }));
    const dear = contributions(candidate({ lexicalScore: 4, estimatedTokens: 400 }));
    expect(dear.total).toBeLessThan(cheap.total);
  });

  it('saturates lexical evidence — a sixth matching word is not worth a third file', () => {
    const four = contributions(candidate({ lexicalScore: 4 })).anchorRelevance;
    const twelve = contributions(candidate({ lexicalScore: 12 })).anchorRelevance;
    expect(twelve).toBe(four);
  });

  it('takes its weights from the argument, not from a constant inside the loop', () => {
    const c = candidate({ structuralScore: 1, confidenceScore: 0.7, relationships: ['imports:src/b.ts'] });
    const muted = { ...DEFAULT_SCORE_WEIGHTS, structuralRelevance: 0, expectedExplorationAvoided: 0 };
    expect(contributions(c, muted).total).toBeLessThan(contributions(c).total);
  });
});

describe('scoring order', () => {
  it('puts a direct structural relationship above a generic lexical match', () => {
    const structural = candidate({
      path: 'src/auth/store.ts', structuralScore: 1, confidenceScore: 0.7,
      relationships: ['imports:src/auth/session.ts'],
    });
    const lexical = candidate({ path: 'docs/auth.md', lexicalScore: 2, confidenceScore: 0.3 });
    expect(score(structural)).toBeGreaterThan(score(lexical));
  });

  it('puts an anchored file above everything', () => {
    const anchor = candidate({ relationships: ['anchor'], structuralScore: 1, confidenceScore: 1, lexicalScore: 4 });
    const neighbour = candidate({ structuralScore: 1, confidenceScore: 0.7, relationships: ['imports:x'] });
    expect(score(anchor)).toBeGreaterThan(score(neighbour));
  });

  it('decays with the strength of the relationship, all else equal', () => {
    const strong = candidate({ structuralScore: 1, confidenceScore: 0.7, relationships: ['imports:x'] });
    const weak = candidate({ structuralScore: 0.25, confidenceScore: 0.7, relationships: ['imports:x'] });
    expect(score(strong)).toBeGreaterThan(score(weak));
  });

  it('prefers a reusable candidate when nothing else separates two', () => {
    const base = { structuralScore: 1, confidenceScore: 0.7, relationships: ['imports:x'] };
    expect(score(candidate({ ...base, reuseScore: 1 }))).toBeGreaterThan(score(candidate(base)));
  });

  it('is deterministic', () => {
    const c = candidate({ lexicalScore: 3, structuralScore: 0.5, confidenceScore: 0.7 });
    expect(score(c)).toBe(score(c));
  });
});

describe('marginalValue', () => {
  it('prefers the cheaper of two equally good candidates', () => {
    const cheap = candidate({ estimatedTokens: 10 });
    const dear = candidate({ estimatedTokens: 200 });
    expect(marginalValue(cheap, 10)).toBeGreaterThan(marginalValue(dear, 10));
  });

  it('never divides by zero on a candidate that renders to nothing', () => {
    expect(Number.isFinite(marginalValue(candidate({ estimatedTokens: 0 }), 5))).toBe(true);
  });
});
