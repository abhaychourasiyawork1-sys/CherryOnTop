import { describe, it, expect, afterEach } from 'vitest';
import {
  routingStateSignature, stateSignatureKey, predictionCacheKey, candidateFingerprint, estimateTransition,
  registerEmpiricalEstimator, clearPredictionCache, validEstimate,
  type ActionTransitionEstimate, type FunnelStats,
} from './transition.js';
import { chooseEconomicAction } from './engine.js';
import { deterministicEstimate, signalEstimate } from './utility.js';
import { actionCandidate } from './actions.js';
import { initialEconomicState, normalizeEconomicState, type EconomicState } from './state.js';

const state = (over: Partial<EconomicState> = {}) => normalizeEconomicState({
  ...initialEconomicState({ goal: 'g', totalTokenBudget: 100_000, repositoryRevision: 'r1' }), ...over,
});

const exec = (id: string, fingerprint: string) => actionCandidate({
  id, kind: 'continue', capability: 'execution.dispatch', tokenCost: 1_000, confidence: 0.5,
  metadata: { fingerprint, capabilityFingerprint: 'cap' },
});

const fixed = (actionId: string, usd: number): ActionTransitionEstimate => ({
  actionId,
  immediateCost: { tokens: 1_000, usd, latencyMs: 0 },
  outcomes: [{ probability: 1, completed: true, succeeded: true, nextStateDelta: { progress: 1 } }],
  expectedRemainingCost: { tokens: 0, usd: 0, latencyMs: 0 },
  bounds: { successLowerBound: 0.95, costUpperBoundUsd: usd },
  confidence: 0.9, provenance: 'empirical', evidenceIds: [],
});

const levels = { deterministic: deterministicEstimate, signals: signalEstimate };
const stats = (): FunnelStats => ({ cacheHits: 0, cacheMisses: 0, estimatorCalls: 0 });

let unregister: () => void = () => {};
afterEach(() => { unregister(); clearPredictionCache(); });

describe('routing state signature', () => {
  it('buckets nearby states together and distant ones apart', () => {
    const a = state({ uncertainty: { target: 0.61, structural: 0.3, behavioral: 0.3, validation: 0.3 } });
    const b = state({ uncertainty: { target: 0.66, structural: 0.3, behavioral: 0.3, validation: 0.3 } });
    const c = state({ uncertainty: { target: 0.95, structural: 0.3, behavioral: 0.3, validation: 0.3 } });
    expect(stateSignatureKey(routingStateSignature(a))).toBe(stateSignatureKey(routingStateSignature(b)));
    expect(stateSignatureKey(routingStateSignature(a))).not.toBe(stateSignatureKey(routingStateSignature(c)));
  });

  it('counts what other commitments reserved as budget already gone', () => {
    const free = routingStateSignature(state());
    const reserved = routingStateSignature(state({ resources: { ...state().resources, reservedTokens: 90_000 } }));
    expect(reserved.budget).toBeLessThan(free.budget);
  });
});

describe('the transition prediction cache', () => {
  it('answers a repeat question from the cache, without asking the estimator again', () => {
    let calls = 0;
    unregister = registerEmpiricalEstimator('test', (c) => { calls += 1; return fixed(c.id, 0.01); });
    const s1 = stats();
    estimateTransition(exec('a', 'fp-a'), state(), {}, levels, s1);
    estimateTransition(exec('a', 'fp-a'), state(), {}, levels, s1);
    expect(calls).toBe(1);
    expect(s1.cacheHits).toBe(1);
    expect(s1.cacheMisses).toBe(1);
  });

  it('keys on candidate identity: the same model on another harness is another question', () => {
    const s = state();
    expect(predictionCacheKey(exec('a', 'claude|sonnet'), s, {})).not.toBe(predictionCacheKey(exec('a', 'codex|sonnet'), s, {}));
  });

  it('is invalidated by a new revision, new evidence, or a changed claim', () => {
    const c = exec('a', 'fp');
    const base = predictionCacheKey(c, state(), { evidenceVersion: 1 });
    expect(predictionCacheKey(c, state({ repositoryRevision: 'r2' }), { evidenceVersion: 1 })).not.toBe(base);
    expect(predictionCacheKey(c, state(), { evidenceVersion: 2 })).not.toBe(base);
    expect(predictionCacheKey({ ...c, tokenCost: 5_000 }, state(), { evidenceVersion: 1 })).not.toBe(base);
  });

  it('never caches a deterministic answer, which is cheaper to recompute', () => {
    const done = state({ validation: { required: true, confidence: 1, status: 'passed' } });
    const s1 = stats();
    const stop = actionCandidate({ id: 'stop', kind: 'stop', capability: 'runtime.stop' });
    expect(estimateTransition(stop, done, {}, levels, s1).provenance).toBe('deterministic');
    expect(s1.cacheMisses).toBe(0);
  });
});

describe('the estimation funnel', () => {
  it('falls through an estimator that throws, and one that returns nonsense', () => {
    unregister = registerEmpiricalEstimator('broken', (c) => {
      if (c.id === 'throws') throw new Error('no');
      return { ...fixed(c.id, 0.01), outcomes: [{ probability: 0.4, completed: true, succeeded: true, nextStateDelta: {} }] };
    });
    for (const id of ['throws', 'nonsense']) {
      const e = estimateTransition(exec(id, `fp-${id}`), state(), {}, levels, stats());
      // Fell through to the candidate's own signals — labelled as such, never
      // as an exact answer, so calibration charges the right estimator.
      expect(e.provenance).toBe('signal');
      expect(validEstimate(e)).toBe(true);
    }
  });

  it('prefers a provider’s own estimate to a bucketed guess', () => {
    const c = exec('a', 'fp');
    const decision = chooseEconomicAction({ state: state(), candidates: [c], estimates: { a: fixed('a', 0.004) } });
    expect(decision.estimate?.immediateCost.usd).toBe(0.004);
  });

  it('measures what deciding cost', () => {
    const decision = chooseEconomicAction({ state: state(), candidates: [exec('a', 'fp'), exec('b', 'fp2')] });
    expect(decision.overhead?.candidateCount).toBe(2);
    expect(decision.overhead?.cacheMisses).toBe(2);
    expect(candidateFingerprint(exec('a', 'fp'))).toBe('fp');
  });
});

describe('dominance', () => {
  it('prunes a candidate beaten on every axis, and records that it did', () => {
    const cheap = actionCandidate({ id: 'cheap', kind: 'acquire_evidence', capability: 'x', tokenCost: 100, expectedTokenBenefit: 5_000, confidence: 1 });
    const dear = actionCandidate({ id: 'dear', kind: 'acquire_evidence', capability: 'x', tokenCost: 900, expectedTokenBenefit: 5_000, confidence: 1 });
    const decision = chooseEconomicAction({ state: state(), candidates: [cheap, dear] });
    expect(decision.action.id).toBe('cheap');
    expect(decision.pruned).toContain('dear');
    expect(decision.ranked?.map((r) => r.id)).not.toContain('dear');
  });

  it('reports the decision margin between the two best survivors', () => {
    // Neither dominates: the cheaper one carries a little quality risk.
    const a = actionCandidate({ id: 'a', kind: 'acquire_evidence', capability: 'x', tokenCost: 100, expectedTokenBenefit: 9_000, qualityRisk: 0.02, confidence: 1 });
    const b = actionCandidate({ id: 'b', kind: 'acquire_evidence', capability: 'y', tokenCost: 5_000, expectedTokenBenefit: 9_000, confidence: 1 });
    const decision = chooseEconomicAction({ state: state(), candidates: [a, b] });
    expect(decision.pruned).not.toContain('a');
    expect(decision.pruned).not.toContain('b');
    expect(decision.margin?.absoluteUsd).toBeGreaterThan(0);
    expect(decision.margin?.relative).toBeGreaterThan(0);
  });
});
