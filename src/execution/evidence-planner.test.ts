import { describe, it, expect } from 'vitest';
import {
  planEvidence, scoreCandidate, candidatesFor, MIN_WORTHWHILE_SCORE,
  type EvidenceCandidate,
} from './evidence-planner.js';
import { EMPTY_FRONTIER, updateFrontier } from '../context/frontier.js';
import type { ContextRef } from '../context/types.js';

const ref = (id: string): ContextRef => ({ semanticId: id, version: 1, contentHash: `h-${id}` });
const open = updateFrontier(EMPTY_FRONTIER, { raised: [ref('a')] });

const candidate = (over: Partial<EvidenceCandidate> = {}): EvidenceCandidate => ({
  action: 'run_model', estimatedTokens: 10_000, estimatedLatencyMs: 30_000,
  expectedGain: 0.9, reason: 'a dispatch', ...over,
});

describe('scoring', () => {
  it('prefers what teaches the same thing for less', () => {
    const cheap = candidate({ action: 'expand', estimatedTokens: 500, estimatedLatencyMs: 0, expectedGain: 0.8 });
    const dear = candidate();
    expect(scoreCandidate(cheap)).toBeGreaterThan(scoreCandidate(dear));
  });

  it('treats something already in hand as unbeatable', () => {
    const held = candidate({ action: 'reuse', estimatedTokens: 0, estimatedLatencyMs: 0, expectedGain: 1 });
    expect(scoreCandidate(held)).toBe(Number.POSITIVE_INFINITY);
  });

  it('gives nothing for an action that teaches nothing, however cheap', () => {
    expect(scoreCandidate(candidate({ estimatedTokens: 0, estimatedLatencyMs: 0, expectedGain: 0 }))).toBe(0);
  });
});

describe('planning', () => {
  it('stops when the frontier is closed, however good a candidate looks', () => {
    // The whole point. A closed frontier makes every candidate irrelevant, and
    // a planner that scores first and checks second gathers evidence nobody
    // needs.
    const decision = planEvidence(EMPTY_FRONTIER, [candidate({ action: 'reuse', estimatedTokens: 0, estimatedLatencyMs: 0 })]);
    expect(decision.stop).toBe(true);
    expect(decision.chosen).toBeNull();
    expect(decision.reason).toMatch(/frontier is closed/);
  });

  it('picks the deterministic tool over the model when both would settle it', () => {
    const decision = planEvidence(open, [
      candidate(),
      candidate({ action: 'search', estimatedTokens: 200, estimatedLatencyMs: 500, expectedGain: 0.4, reason: 'a search' }),
    ]);
    expect(decision.chosen?.action).toBe('search');
    // The receipt names what it beat, not just what it chose.
    expect(decision.reason).toMatch(/over run_model/);
  });

  it('declines to gather when the best option costs more than it is worth', () => {
    // Forty turns and no answer is what this prevents.
    const decision = planEvidence(open, [candidate({ expectedGain: 0.01, estimatedTokens: 500_000, estimatedLatencyMs: 300_000 })]);
    expect(decision.stop).toBe(true);
    expect(decision.reason).toMatch(/cost more than it is expected to be worth/);
  });

  it('stops when nothing at all can settle the gap', () => {
    const decision = planEvidence(open, []);
    expect(decision.stop).toBe(true);
    expect(decision.ranked).toEqual([]);
  });

  it('records every alternative with its score, best first', () => {
    const decision = planEvidence(open, [candidate(), candidate({ action: 'expand', estimatedTokens: 100, estimatedLatencyMs: 0, expectedGain: 0.8 })]);
    expect(decision.ranked.map((r) => r.candidate.action)).toEqual(['expand', 'run_model']);
    expect(decision.ranked[0].score).toBeGreaterThan(decision.ranked[1].score);
  });

  it('breaks a tie towards the cheaper kind of action', () => {
    const tied = { estimatedTokens: 1000, estimatedLatencyMs: 1000, expectedGain: 0.5, reason: 'tied' };
    const decision = planEvidence(open, [candidate({ ...tied, action: 'run_model' }), candidate({ ...tied, action: 'reuse' })]);
    expect(decision.chosen?.action).toBe('reuse');
  });

  it('uses a floor low enough that ordinary work still happens', () => {
    // A guard that stops everything is not a guard, it is an outage.
    const ordinary = candidate();
    expect(scoreCandidate(ordinary)).toBeGreaterThan(MIN_WORTHWHILE_SCORE);
  });
});

describe('generating candidates from what the graph already holds', () => {
  const inputs = {
    held: new Map([['repo_file:a.ts', { ref: ref('repo_file:a.ts'), tokens: 400 }]]),
    expandable: new Map([['repo_file:b.ts', { ref: ref('repo_file:b.ts'), tokens: 120 }]]),
    dispatchTokens: 1_772_218,
    dispatchLatencyMs: 263_000,
  };

  it('offers reuse for something already held, and prefers it', () => {
    const decision = planEvidence(open, candidatesFor(ref('repo_file:a.ts'), inputs));
    expect(decision.chosen?.action).toBe('reuse');
  });

  it('offers expansion for something indexed but not materialized', () => {
    const decision = planEvidence(open, candidatesFor(ref('repo_file:b.ts'), inputs));
    expect(decision.chosen?.action).toBe('expand');
  });

  it('falls through to a dispatch only when nothing cheaper applies', () => {
    const candidates = candidatesFor(ref('repo_file:unknown.ts'), inputs);
    expect(candidates.map((c) => c.action)).toEqual(['search', 'run_model']);
    // ...and even then, a search is tried first.
    expect(planEvidence(open, candidates).chosen?.action).toBe('search');
  });

  it('prices a dispatch from what one actually cost, not from a guess', () => {
    const dispatch = candidatesFor(ref('x'), inputs).find((c) => c.action === 'run_model')!;
    expect(dispatch.estimatedTokens).toBe(1_772_218);
    expect(dispatch.estimatedLatencyMs).toBe(263_000);
  });
});
