import { describe, it, expect } from 'vitest';
import {
  evaluateRecovery, partitionEvidence, successProbability, tombstoneFor, recoveryCandidate,
  type RecoveryTombstone,
} from './engine.js';
import { initialEconomicState, normalizeEconomicState, type EconomicState, type EvidenceRef } from '../decision/state.js';

const ref = (id: string, kind: EvidenceRef['kind'], tokenCost = 100): EvidenceRef =>
  ({ id, kind, source: `src:${id}`, confidence: 0.9, tokenCost });

function state(over: Partial<EconomicState> = {}): EconomicState {
  const base = initialEconomicState({ goal: 'g', totalTokenBudget: 100_000, qualityFloor: 0.7 });
  return normalizeEconomicState({
    ...base,
    evidence: [
      ref('fact:src/a.ts', 'fact'),
      ref('validation:test-a', 'validation'),
      ref('observation:grep-refresh', 'observation'),
      ref('hypothesis:bug-in-parser', 'hypothesis'),
    ],
    resources: { ...base.resources, consumedTokens: 40_000 },
    trajectory: { ...base.trajectory, progress: 0.5, failurePressure: 0.8, orchestrationConfidence: 0.8 },
    ...over,
  });
}

const FAILURE = 'Bash#npm test#error TS2345';

describe('a failed strategy does not make its observations untrue', () => {
  it('keeps facts, validations and observations across a retry', () => {
    const { retained } = partitionEvidence(state());
    expect(retained.map((r) => r.id)).toEqual([
      'fact:src/a.ts', 'validation:test-a', 'observation:grep-refresh',
    ]);
  });

  it('drops the hypothesis the attempt rested on', () => {
    const { invalidated } = partitionEvidence(state());
    expect(invalidated.map((r) => r.id)).toEqual(['hypothesis:bug-in-parser']);
  });

  it('drops anything the caller names as a hypothesis, whatever its kind says', () => {
    // The caller knows what the attempt was resting on; this module does not.
    const result = evaluateRecovery({
      state: state(), failureSignature: FAILURE,
      hypothesisIds: ['fact:src/a.ts'],
    });
    expect(result.invalidatedEvidenceIds).toContain('fact:src/a.ts');
    expect(result.retainedEvidenceIds).not.toContain('fact:src/a.ts');
  });

  it('reports what it kept and what it killed', () => {
    const result = evaluateRecovery({ state: state(), failureSignature: FAILURE });
    expect(result.reasonCodes).toContain('retains_evidence:3');
    expect(result.reasonCodes).toContain('invalidates_hypotheses:1');
  });
});

describe('a disproven belief stays disproven', () => {
  const tombstone: RecoveryTombstone = {
    id: 't1', hypothesisIds: ['hypothesis:bug-in-parser'],
    retainedEvidenceIds: ['fact:src/a.ts'],
    invalidatedEvidenceIds: ['hypothesis:bug-in-parser', 'fact:src/a.ts'],
    failureSignature: FAILURE, tokensSpent: 20_000,
  };

  it('does not resurrect evidence a previous recovery invalidated', () => {
    const { retained } = partitionEvidence(state(), [tombstone]);
    // `fact:src/a.ts` survives its *kind*, but a prior recovery already ruled
    // it out — a run must not be able to bring a belief back by failing again.
    expect(retained.map((r) => r.id)).not.toContain('fact:src/a.ts');
  });

  it('carries the ruling through the evaluation', () => {
    const result = evaluateRecovery({ state: state(), failureSignature: FAILURE, tombstones: [tombstone] });
    expect(result.retainedEvidenceIds).not.toContain('fact:src/a.ts');
    expect(result.invalidatedEvidenceIds).toContain('fact:src/a.ts');
  });

  it('does not re-acquire retained evidence, which is what makes a second attempt cheaper', () => {
    const rich = state();
    const poor = state({ evidence: [ref('hypothesis:guess', 'hypothesis')] });
    const withKnowledge = evaluateRecovery({ state: rich, failureSignature: FAILURE });
    const withNone = evaluateRecovery({ state: poor, failureSignature: FAILURE });
    expect(withKnowledge.expectedCost).toBeLessThan(withNone.expectedCost);
  });

  it('prices evidence by what it cost to get, not by how many pieces there are', () => {
    const cheap = state({ evidence: [ref('fact:a', 'fact', 1), ref('hypothesis:h', 'hypothesis', 10_000)] });
    const dear = state({ evidence: [ref('fact:a', 'fact', 10_000), ref('hypothesis:h', 'hypothesis', 1)] });
    expect(evaluateRecovery({ state: dear, failureSignature: FAILURE }).expectedCost)
      .toBeLessThan(evaluateRecovery({ state: cheap, failureSignature: FAILURE }).expectedCost);
  });
});

describe('how likely trying again is to work', () => {
  it('falls sharply for an attempt that already died the same way', () => {
    const same = (n: number): RecoveryTombstone[] => Array.from({ length: n }, (_, i) => ({
      id: `t${i}`, hypothesisIds: [], retainedEvidenceIds: [], invalidatedEvidenceIds: [],
      failureSignature: FAILURE, tokensSpent: 1_000,
    }));
    const first = successProbability(state(), FAILURE, [], 0.5);
    const second = successProbability(state(), FAILURE, same(1), 0.5);
    const third = successProbability(state(), FAILURE, same(2), 0.5);
    expect(second).toBeLessThan(first);
    expect(third).toBeLessThan(second);
    // Halving, not decrementing: the gap between the first and second retry is
    // large and between the fourth and fifth negligible.
    expect(first - second).toBeGreaterThan(second - third);
  });

  it('is untouched by attempts that died differently', () => {
    // A run working through three distinct problems is making progress, and
    // counting those against it would stop exactly the run about to succeed.
    const different: RecoveryTombstone[] = ['a', 'b', 'c'].map((s) => ({
      id: s, hypothesisIds: [], retainedEvidenceIds: [], invalidatedEvidenceIds: [],
      failureSignature: `other:${s}`, tokensSpent: 1_000,
    }));
    expect(successProbability(state(), FAILURE, different, 0.5))
      .toBeCloseTo(successProbability(state(), FAILURE, [], 0.5));
  });

  it('rises with what the retry inherits', () => {
    expect(successProbability(state(), FAILURE, [], 0.9))
      .toBeGreaterThan(successProbability(state(), FAILURE, [], 0.1));
  });

  it('rises with how far the run had already got', () => {
    const nearlyThere = state({ trajectory: { ...state().trajectory, progress: 0.9 } });
    const fellOverEarly = state({ trajectory: { ...state().trajectory, progress: 0 } });
    expect(successProbability(nearlyThere, FAILURE, [], 0.5))
      .toBeGreaterThan(successProbability(fellOverEarly, FAILURE, [], 0.5));
  });

  it('stays inside [0,1]', () => {
    expect(successProbability(state({ trajectory: { ...state().trajectory, progress: 1 } }), FAILURE, [], 1))
      .toBeLessThanOrEqual(1);
    expect(successProbability(state(), FAILURE, [], 0)).toBeGreaterThanOrEqual(0);
  });
});

describe('whether a retry is worth making', () => {
  it('justifies one for a run that has spent a lot and knows a lot', () => {
    expect(evaluateRecovery({ state: state(), failureSignature: FAILURE }).justified).toBe(true);
  });

  it('refuses one for a run that has learned nothing and keeps dying the same way', () => {
    const hopeless = state({
      evidence: [ref('hypothesis:guess', 'hypothesis')],
      resources: { ...state().resources, consumedTokens: 1_000 },
      trajectory: { ...state().trajectory, progress: 0 },
    });
    const repeats: RecoveryTombstone[] = [0, 1, 2].map((i) => ({
      id: `t${i}`, hypothesisIds: [], retainedEvidenceIds: [], invalidatedEvidenceIds: [],
      failureSignature: FAILURE, tokensSpent: 1_000,
    }));
    expect(evaluateRecovery({ state: hopeless, failureSignature: FAILURE, tombstones: repeats }).justified).toBe(false);
  });

  it('refuses one it cannot afford', () => {
    const broke = state({ resources: { ...state().resources, consumedTokens: 99_900 } });
    const result = evaluateRecovery({ state: broke, failureSignature: FAILURE });
    expect(result.reasonCodes).toContain('retains_evidence:3');
    expect(result.expectedCost).toBeLessThanOrEqual(broke.resources.remainingTokens);
  });

  it('refuses one on a task that is already over', () => {
    const done = state({ constraints: { qualityFloor: 0.7, hardStop: true } });
    const result = evaluateRecovery({ state: done, failureSignature: FAILURE });
    expect(result.justified).toBe(false);
    expect(result.reasonCodes).toContain('hard_stop');
  });

  it('is deterministic', () => {
    const input = { state: state(), failureSignature: FAILURE };
    expect(evaluateRecovery(input)).toEqual(evaluateRecovery(input));
  });
});

describe('the tombstone left behind', () => {
  it('records what survived, what did not, and how it died', () => {
    const evaluation = evaluateRecovery({ state: state(), failureSignature: FAILURE });
    const tombstone = tombstoneFor({
      id: 't1', evaluation, failureSignature: FAILURE, tokensSpent: 12_345,
    });
    expect(tombstone.retainedEvidenceIds).toEqual(evaluation.retainedEvidenceIds);
    expect(tombstone.invalidatedEvidenceIds).toEqual(evaluation.invalidatedEvidenceIds);
    expect(tombstone.failureSignature).toBe(FAILURE);
    expect(tombstone.tokensSpent).toBe(12_345);
  });

  it('never records negative spend', () => {
    const evaluation = evaluateRecovery({ state: state(), failureSignature: FAILURE });
    expect(tombstoneFor({ id: 't', evaluation, failureSignature: FAILURE, tokensSpent: -5 }).tokensSpent).toBe(0);
  });

  it('is small — a record of what was ruled out, not a transcript', () => {
    const evaluation = evaluateRecovery({ state: state(), failureSignature: FAILURE });
    const tombstone = tombstoneFor({ id: 't', evaluation, failureSignature: FAILURE, tokensSpent: 1 });
    expect(JSON.stringify(tombstone).length).toBeLessThan(1_000);
  });
});

describe('recovery competes rather than taking a privileged path', () => {
  it('produces an ordinary action candidate the engine can rank', () => {
    const evaluation = evaluateRecovery({ state: state(), failureSignature: FAILURE });
    const candidate = recoveryCandidate(evaluation, state());
    expect(candidate.kind).toBe('recover');
    expect(candidate.tokenCost).toBe(evaluation.expectedCost);
    expect(candidate.expectedProgress).toBeCloseTo(evaluation.expectedSuccessProbability);
  });

  it('prices its own risk of failing the same way', () => {
    const evaluation = evaluateRecovery({ state: state(), failureSignature: FAILURE });
    const candidate = recoveryCandidate(evaluation, state());
    expect(candidate.failureRisk).toBeCloseTo(1 - evaluation.expectedSuccessProbability);
  });

  it('carries what the retry would inherit, for whoever carries it out', () => {
    const evaluation = evaluateRecovery({ state: state(), failureSignature: FAILURE });
    const candidate = recoveryCandidate(evaluation, state());
    expect(candidate.metadata.retainedEvidenceIds).toEqual(evaluation.retainedEvidenceIds);
  });
});
