import { describe, it, expect, afterEach, vi } from 'vitest';
import { inspectFastPath, DEEP_EVALUATION_TOKEN_COST } from './fast-path.js';
import {
  evaluateDeepPath, registerCandidateSource, registeredCandidateSources, deepPathInProgress,
  historicalEvidenceSource, MAX_HISTORICAL_CANDIDATES,
} from './deep-path.js';
import { initialEconomicState, normalizeEconomicState, type EconomicState } from './state.js';
import { actionCandidate } from './actions.js';

function state(over: Partial<EconomicState> = {}): EconomicState {
  const base = initialEconomicState({ goal: 'g', totalTokenBudget: 100_000, qualityFloor: 0.7 });
  return normalizeEconomicState({ ...base, ...over });
}

/** A run that is going well: doubt resolved, evidence in hand, progress real,
 *  nothing repeating, money proportional to work done. */
function healthy(over: Partial<EconomicState> = {}): EconomicState {
  return state({
    evidence: [
      { id: 'e1', kind: 'fact', source: 'read:a', confidence: 0.9 },
      { id: 'e2', kind: 'fact', source: 'read:b', confidence: 0.9 },
      { id: 'e3', kind: 'validation', source: 'test', confidence: 0.9 },
    ],
    uncertainty: { target: 0.1, structural: 0.1, behavioral: 0.2, validation: 0.1 },
    trajectory: {
      progress: 0.6, informationGain: 0.7, explorationPressure: 0.2,
      failurePressure: 0, stateSimilarity: 0.2, orchestrationConfidence: 0.8,
    },
    resources: { ...state().resources, consumedTokens: 30_000 },
    validation: { required: true, confidence: 0.9, status: 'passed' },
    ...over,
  });
}

describe('the fast path costs nothing and usually says no', () => {
  it('sees no opportunity in a healthy, progressing run', () => {
    const result = inspectFastPath(healthy());
    expect(result.opportunity).toBe(false);
    expect(result.pressure).toBeLessThanOrEqual(result.bar);
  });

  it('needs no graph, memory or database — only the state it was handed', () => {
    // Frozen deeply: any attempt to reach out and mutate, cache or lazily
    // populate would throw here rather than pass silently.
    const s = healthy();
    Object.freeze(s);
    Object.freeze(s.trajectory);
    Object.freeze(s.uncertainty);
    Object.freeze(s.resources);
    Object.freeze(s.evidence);
    expect(() => inspectFastPath(s)).not.toThrow();
  });

  it('is deterministic', () => {
    const s = healthy();
    expect(inspectFastPath(s)).toEqual(inspectFastPath(s));
  });
});

describe('the fast path finds material opportunities', () => {
  it('sees identifiable missing evidence', () => {
    const lost = healthy({
      evidence: [],
      uncertainty: { target: 0.9, structural: 0.9, behavioral: 0.5, validation: 0.5 },
    });
    const result = inspectFastPath(lost);
    expect(result.opportunity).toBe(true);
    expect(result.reasons).toContain('identifiable_missing_evidence');
  });

  it('sees repeated failure', () => {
    const failing = healthy({
      trajectory: { ...healthy().trajectory, failurePressure: 0.9, progress: 0.1 },
    });
    const result = inspectFastPath(failing);
    expect(result.opportunity).toBe(true);
    expect(result.reasons).toContain('repeated_failure');
  });

  it('sees duplication only when it produced nothing', () => {
    const stuck = healthy({
      trajectory: { ...healthy().trajectory, stateSimilarity: 0.9, informationGain: 0.05 },
    });
    expect(inspectFastPath(stuck).reasons).toContain('high_duplication');

    // The same repetition, but it is learning something. Careful work in one
    // file looks exactly like this, and stopping it would be the wrong call.
    const productive = healthy({
      trajectory: { ...healthy().trajectory, stateSimilarity: 0.9, informationGain: 0.9 },
    });
    expect(inspectFastPath(productive).reasons).not.toContain('high_duplication');
  });

  it('sees validation uncertainty, scaled by how much there is to validate', () => {
    const unproven = healthy({
      validation: { required: true, confidence: 0, status: 'unknown' },
      uncertainty: { ...healthy().uncertainty, validation: 0.9 },
      trajectory: { ...healthy().trajectory, progress: 0.9 },
    });
    expect(inspectFastPath(unproven).reasons).toContain('validation_uncertainty');

    // Nothing done yet, so nothing to prove — the same doubt is not an
    // opportunity.
    const early = healthy({
      validation: { required: true, confidence: 0, status: 'unknown' },
      uncertainty: { ...healthy().uncertainty, validation: 0.9 },
      trajectory: { ...healthy().trajectory, progress: 0 },
    });
    expect(inspectFastPath(early).reasons).not.toContain('validation_uncertainty');
  });

  it('sees resource pressure as spend outrunning progress, not as spend alone', () => {
    const outrunning = healthy({
      resources: { ...healthy().resources, consumedTokens: 80_000 },
      trajectory: { ...healthy().trajectory, progress: 0.1 },
    });
    expect(inspectFastPath(outrunning).reasons).toContain('resource_pressure');

    // 80% spent, 90% done. Expensive and fine.
    const onTrack = healthy({
      resources: { ...healthy().resources, consumedTokens: 80_000 },
      trajectory: { ...healthy().trajectory, progress: 0.9 },
    });
    expect(inspectFastPath(onTrack).reasons).not.toContain('resource_pressure');
  });

  it('orders reasons strongest first', () => {
    const messy = healthy({
      evidence: [],
      uncertainty: { target: 1, structural: 1, behavioral: 1, validation: 0.3 },
      trajectory: { ...healthy().trajectory, failurePressure: 0.2, progress: 0.1 },
    });
    expect(inspectFastPath(messy).reasons[0]).toBe('identifiable_missing_evidence');
  });
});

describe('the screening bar is economic, not constant', () => {
  it('rises as the optimization allowance is spent', () => {
    const weak = { ...healthy().trajectory, stateSimilarity: 0.2, informationGain: 0.05 };
    const early = healthy({ trajectory: weak });
    const late = healthy({
      trajectory: weak,
      resources: {
        ...healthy().resources,
        optimizationConsumedTokens: healthy().resources.optimizationTokens - DEEP_EVALUATION_TOKEN_COST * 2,
      },
    });
    expect(inspectFastPath(late).bar).toBeGreaterThan(inspectFastPath(early).bar);
    expect(inspectFastPath(early).opportunity).toBe(true);
    expect(inspectFastPath(late).opportunity).toBe(false);
  });

  it('stops screening entirely once the optimizer has spent its allowance', () => {
    const spent = healthy({
      evidence: [],
      uncertainty: { target: 1, structural: 1, behavioral: 1, validation: 1 },
      resources: {
        ...healthy().resources,
        optimizationConsumedTokens: healthy().resources.optimizationTokens,
      },
    });
    const result = inspectFastPath(spent);
    expect(result.opportunity).toBe(false);
    expect(result.reasons).toEqual(['optimization_budget_exhausted']);
  });

  it('sees no opportunity in a task that is already over', () => {
    const done = healthy({ constraints: { qualityFloor: 0.7, hardStop: true } });
    expect(inspectFastPath(done).opportunity).toBe(false);
  });

  it('reports lower confidence when the orchestrator trusts itself less', () => {
    const signals = { ...healthy().trajectory, failurePressure: 0.9, progress: 0.1 };
    const sure = inspectFastPath(healthy({ trajectory: { ...signals, orchestrationConfidence: 0.9 } }));
    const unsure = inspectFastPath(healthy({ trajectory: { ...signals, orchestrationConfidence: 0.2 } }));
    expect(unsure.confidence).toBeLessThan(sure.confidence);
  });
});

describe('the deep path proposes', () => {
  afterEach(() => {
    for (const name of registeredCandidateSources()) registerCandidateSource(name, () => [])();
  });

  it('proposes validation for unvalidated progress', () => {
    const unproven = healthy({
      validation: { required: true, confidence: 0, status: 'unknown' },
      uncertainty: { ...healthy().uncertainty, validation: 0.9 },
    });
    expect(evaluateDeepPath(unproven).map((c) => c.kind)).toContain('validate');
  });

  it('proposes recovery for failure without progress, and prices its own risk', () => {
    const failing = healthy({ trajectory: { ...healthy().trajectory, failurePressure: 0.8, progress: 0.1 } });
    const recover = evaluateDeepPath(failing).find((c) => c.kind === 'recover');
    expect(recover).toBeDefined();
    expect(recover!.failureRisk).toBeGreaterThan(0);
  });

  it('proposes narrowing rather than stopping for unproductive repetition', () => {
    const stuck = healthy({ trajectory: { ...healthy().trajectory, stateSimilarity: 0.9, informationGain: 0 } });
    const kinds = evaluateDeepPath(stuck).map((c) => c.kind);
    expect(kinds).toContain('constrain');
    expect(kinds).not.toContain('stop');
  });

  it('proposes nothing for a healthy run', () => {
    expect(evaluateDeepPath(healthy())).toEqual([]);
  });

  it('includes candidates from registered sources', () => {
    registerCandidateSource('test-source', () => [
      actionCandidate({ id: 'src:1', kind: 'reuse_evidence', capability: 'evidence.store' }),
    ]);
    expect(evaluateDeepPath(healthy()).map((c) => c.id)).toContain('src:1');
  });

  it('replaces a source registered twice under one name', () => {
    registerCandidateSource('dup', () => [actionCandidate({ id: 'a', kind: 'explore', capability: 'x' })]);
    registerCandidateSource('dup', () => [actionCandidate({ id: 'a', kind: 'explore', capability: 'x' })]);
    expect(evaluateDeepPath(healthy()).filter((c) => c.id === 'a')).toHaveLength(1);
  });

  it('loses only the failing source’s candidates when one throws', () => {
    registerCandidateSource('broken', () => { throw new Error('no'); });
    registerCandidateSource('fine', () => [actionCandidate({ id: 'ok', kind: 'explore', capability: 'x' })]);
    expect(evaluateDeepPath(healthy()).map((c) => c.id)).toEqual(['ok']);
  });

  it('returns candidates in a deterministic order', () => {
    registerCandidateSource('z', () => [actionCandidate({ id: 'zzz', kind: 'explore', capability: 'x' })]);
    registerCandidateSource('a', () => [actionCandidate({ id: 'aaa', kind: 'explore', capability: 'x' })]);
    expect(evaluateDeepPath(healthy()).map((c) => c.id)).toEqual(['aaa', 'zzz']);
  });

  it('is not recursively invoked by itself', () => {
    let innerResult: unknown;
    let sawGuard = false;
    registerCandidateSource('recursive', (s) => {
      sawGuard = deepPathInProgress();
      innerResult = evaluateDeepPath(s);
      return [];
    });
    evaluateDeepPath(healthy());
    expect(sawGuard).toBe(true);
    expect(innerResult).toEqual([]);
  });

  it('clears the guard after a source throws, so the next cycle still works', () => {
    registerCandidateSource('broken', () => { throw new Error('no'); });
    evaluateDeepPath(healthy());
    expect(deepPathInProgress()).toBe(false);
  });
});

describe('historical knowledge competes as an ordinary candidate', () => {
  afterEach(() => {
    for (const name of registeredCandidateSources()) registerCandidateSource(name, () => [])();
  });

  const lost = (over: Partial<EconomicState> = {}) => healthy({
    repository: 'github.com/acme/app',
    repositoryRevision: 'rev-1',
    uncertainty: { target: 0.8, structural: 0.8, behavioral: 0.2, validation: 0.1 },
    ...over,
  });

  const item = { id: 'k1', content: 'x'.repeat(400), sourcePaths: ['src/a.ts'], sourceSymbols: [] };
  const usable = {
    usable: true, directReuse: true, requiresVerification: false,
    expectedBenefit: 3_000, retrievalCost: 5, verificationCost: 0, staleRisk: 0,
    reasonCodes: ['same_revision', 'direct_reuse'],
  };

  const source = (over: Partial<typeof usable> = {}, items = [item]) => historicalEvidenceSource({
    lookup: () => items,
    evaluate: () => ({ ...usable, ...over }),
  });

  it('offers a reuse action for knowledge worth retrieving', () => {
    registerCandidateSource('historical', source());
    const candidate = evaluateDeepPath(lost()).find((c) => c.id === 'historical:k1');
    expect(candidate?.kind).toBe('reuse_evidence');
    expect(candidate?.expectedTokenBenefit).toBe(3_000);
    expect(candidate?.tokenCost).toBe(5);
    expect(candidate?.metadata.knowledgeId).toBe('k1');
  });

  it('prices staleness as a quality risk, which a token saving may never buy', () => {
    registerCandidateSource('historical', source({ staleRisk: 0.6, directReuse: false, requiresVerification: true }));
    const candidate = evaluateDeepPath(lost()).find((c) => c.id === 'historical:k1')!;
    expect(candidate.qualityRisk).toBe(0.6);
    // And it makes the candidate less believable, not more.
    expect(candidate.confidence).toBeLessThan(lost().trajectory.orchestrationConfidence);
  });

  it('offers nothing the reuse evaluation refused', () => {
    registerCandidateSource('historical', source({ usable: false }));
    expect(evaluateDeepPath(lost()).filter((c) => c.kind === 'reuse_evidence')).toEqual([]);
  });

  it('does not look at the store when the outstanding doubt is not one it can answer', () => {
    const lookup = vi.fn(() => [item]);
    registerCandidateSource('historical', historicalEvidenceSource({ lookup, evaluate: () => usable }));
    // Knows exactly where it is working; the open question is whether the
    // change is right. Stored knowledge cannot answer that.
    evaluateDeepPath(lost({ uncertainty: { target: 0, structural: 0, behavioral: 0.9, validation: 0.9 } }));
    expect(lookup).not.toHaveBeenCalled();
  });

  it('does not look at the store for a run with no repository identity', () => {
    const lookup = vi.fn(() => [item]);
    registerCandidateSource('historical', historicalEvidenceSource({ lookup, evaluate: () => usable }));
    evaluateDeepPath(healthy({ repository: undefined }));
    expect(lookup).not.toHaveBeenCalled();
  });

  it('asks for a bounded window rather than everything the organization knows', () => {
    const lookup = vi.fn(() => [item]);
    registerCandidateSource('historical', historicalEvidenceSource({ lookup, evaluate: () => usable }));
    evaluateDeepPath(lost());
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ limit: MAX_HISTORICAL_CANDIDATES }));
  });

  it('never reaches the store from a healthy run at all', () => {
    // The screen has to have said there is something worth paying to look into
    // before any of this happens; a healthy run proposes nothing.
    const lookup = vi.fn(() => [item]);
    registerCandidateSource('historical', historicalEvidenceSource({ lookup, evaluate: () => usable }));
    const decided = evaluateDeepPath(healthy());
    expect(decided.filter((c) => c.kind === 'reuse_evidence')).toEqual([]);
  });
});
