import { describe, it, expect } from 'vitest';
import { evidenceActions, candidatesFor, type EvidenceCandidate } from './evidence-planner.js';
import { EMPTY_FRONTIER, updateFrontier } from '../context/frontier.js';
import { chooseEconomicAction } from '../decision/engine.js';
import { initialEconomicState } from '../decision/state.js';
import type { ContextRef } from '../context/types.js';

const ref = (id: string): ContextRef => ({ semanticId: id, version: 1, contentHash: `h-${id}` });
const open = updateFrontier(EMPTY_FRONTIER, { raised: [ref('a')] });

const candidate = (over: Partial<EvidenceCandidate> = {}): EvidenceCandidate => ({
  action: 'run_model', estimatedTokens: 10_000, estimatedLatencyMs: 30_000,
  expectedGain: 0.9, reason: 'a dispatch', ...over,
});

const state = () => initialEconomicState({ goal: 'g', totalTokenBudget: 4_000_000 });

/** What the market makes of the planner's proposals, when finding the answer
 *  by exploration would cost `gap` tokens. */
function choose(frontier: typeof open, candidates: EvidenceCandidate[], gap = 20_000) {
  return chooseEconomicAction({ state: state(), candidates: evidenceActions(frontier, candidates, gap) });
}

describe('proposals, not a choice', () => {
  it('proposes nothing when the frontier is closed, however good a candidate looks', () => {
    expect(evidenceActions(EMPTY_FRONTIER, [candidate({ expectedGain: 1, estimatedTokens: 0 })], 20_000)).toEqual([]);
    expect(choose(EMPTY_FRONTIER, [candidate()]).action.kind).toBe('continue');
  });

  it('prices a way of closing the gap in the market’s units: rediscovery avoided, tokens spent', () => {
    const [action] = evidenceActions(open, [candidate({ expectedGain: 0.5, estimatedTokens: 300 })], 20_000);
    expect(action.expectedTokenBenefit).toBe(10_000);
    expect(action.tokenCost).toBe(300);
    expect(action.expectedInformationGain).toBe(0.5);
  });

  it('lets the market pick the deterministic tool over the model when both would settle it', () => {
    const decision = choose(open, [
      candidate({ action: 'run_model', estimatedTokens: 10_000, expectedGain: 0.9 }),
      candidate({ action: 'search', estimatedTokens: 200, estimatedLatencyMs: 500, expectedGain: 0.8 }),
    ]);
    expect(decision.action.metadata.evidenceAction).toBe('search');
  });

  it('lets the market decline to gather when every way costs more than it is worth', () => {
    const decision = choose(open, [candidate({ estimatedTokens: 50_000, expectedGain: 0.1 })]);
    expect(decision.action.kind).toBe('continue');
    expect(decision.reasonCodes).toContain('no_justified_opportunity');
  });

  it('records the alternatives the market weighed', () => {
    const decision = choose(open, [
      candidate({ action: 'search', estimatedTokens: 200, expectedGain: 0.4 }),
      candidate({ action: 'reuse', estimatedTokens: 50, estimatedLatencyMs: 0, expectedGain: 1 }),
    ]);
    expect((decision.ranked ?? []).length + (decision.pruned ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('generating candidates from what the graph already holds', () => {
  const inputs = {
    held: new Map([['repo_file:a.ts', { ref: ref('repo_file:a.ts'), tokens: 400 }]]),
    expandable: new Map([['repo_file:b.ts', { ref: ref('repo_file:b.ts'), tokens: 120 }]]),
    dispatchTokens: 1_772_218,
    dispatchLatencyMs: 263_000,
  };

  it('offers reuse for something already held, and the market prefers it', () => {
    expect(choose(open, candidatesFor(ref('repo_file:a.ts'), inputs)).action.metadata.evidenceAction).toBe('reuse');
  });

  it('offers expansion for something indexed but not materialized', () => {
    expect(choose(open, candidatesFor(ref('repo_file:b.ts'), inputs)).action.metadata.evidenceAction).toBe('expand');
  });

  it('falls through to a dispatch only when nothing cheaper applies — and a search still wins', () => {
    const candidates = candidatesFor(ref('repo_file:unknown.ts'), inputs);
    expect(candidates.map((c) => c.action)).toEqual(['search', 'run_model']);
    expect(choose(open, candidates).action.metadata.evidenceAction).toBe('search');
  });

  it('prices a dispatch from what one actually cost, not from a guess', () => {
    const dispatch = candidatesFor(ref('x'), inputs).find((c) => c.action === 'run_model')!;
    expect(dispatch.estimatedTokens).toBe(1_772_218);
    expect(dispatch.estimatedLatencyMs).toBe(263_000);
  });
});
