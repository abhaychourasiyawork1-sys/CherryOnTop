/** Fault injection through the real path.
 *
 *  Not unit tests of `evaluateFallback` — `fallback.test.ts` already covers the
 *  rules. These run a whole decision cycle with something broken and assert what
 *  reaches the other side: that the run continues, that Baseline is what it
 *  continues as, and that an unsafe action is refused rather than merely
 *  un-optimized.
 *
 *  The property under test is the one that decides whether an optimizer is safe
 *  to deploy at all: **failing to optimize must never fail the work.** */
import { describe, it, expect, afterEach } from 'vitest';
import { runDecisionCycle } from './orchestration-loop.js';
import { registerCandidateSource, registeredCandidateSources } from './deep-path.js';
import { evaluateFallback, detectFaults, mustBlockAction } from './fallback.js';
import { chooseEconomicAction } from './engine.js';
import { actionCandidate } from './actions.js';
import { initialEconomicState, normalizeEconomicState, type EconomicState } from './state.js';

const frozen = () => 1_000;

function state(over: Partial<EconomicState> = {}): EconomicState {
  const base = initialEconomicState({
    goal: 'g', totalTokenBudget: 100_000, qualityFloor: 0.7, repositoryRevision: 'rev-1',
  });
  return normalizeEconomicState({
    ...base,
    trajectory: { ...base.trajectory, orchestrationConfidence: 0.9, failurePressure: 0.9, progress: 0.1 },
    ...over,
  });
}

afterEach(() => {
  for (const name of registeredCandidateSources()) registerCandidateSource(name, () => [])();
});

describe('missing telemetry', () => {
  it('is detected as a fault rather than read as a healthy run', () => {
    const blind = state({ trajectory: { ...state().trajectory, orchestrationConfidence: 0 } });
    expect(detectFaults(blind)).toContain('missing_telemetry');
  });

  it('falls back to Baseline rather than acting on a run it cannot read', () => {
    const blind = state({ trajectory: { ...state().trajectory, orchestrationConfidence: 0 } });
    const cycle = runDecisionCycle(blind, { nowMs: frozen });
    const fallback = evaluateFallback({
      state: blind, decision: cycle.decision, faults: detectFaults(blind),
    });
    expect(fallback.mode).toBe('baseline');
    expect(fallback.reasons).toContain('missing_telemetry');
    expect(mustBlockAction(fallback)).toBe(false);
  });

  it('falls back when no decision was produced at all', () => {
    const fallback = evaluateFallback({ state: state() });
    expect(fallback.mode).toBe('baseline');
    expect(fallback.reasons).toContain('missing_telemetry');
  });
});

describe('a repository that moved under the run', () => {
  const stale = () => state({
    evidence: [
      { id: 'e1', kind: 'fact', source: 'read:a', confidence: 0.9, repositoryRevision: 'rev-0' },
    ],
  });

  it('is detected as a stale graph', () => {
    expect(detectFaults(stale())).toContain('stale_repository_graph');
  });

  it('does not flag evidence that is not tied to a revision at all', () => {
    // Absent is weaker evidence, not stale evidence, and conflating them would
    // make every run with an untagged observation fall back.
    const untagged = state({
      evidence: [{ id: 'e1', kind: 'observation', source: 'grep', confidence: 0.6 }],
    });
    expect(detectFaults(untagged)).not.toContain('stale_repository_graph');
  });

  it('does not flag a run with no revision of its own to compare against', () => {
    const unknown = normalizeEconomicState({ ...stale(), repositoryRevision: undefined });
    expect(detectFaults(unknown)).not.toContain('stale_repository_graph');
  });

  it('falls back rather than deciding about a tree that has moved', () => {
    const fallback = evaluateFallback({
      state: stale(),
      decision: chooseEconomicAction({ state: stale(), candidates: [] }),
      faults: detectFaults(stale()),
    });
    expect(fallback.mode).toBe('baseline');
    expect(fallback.reason).toContain('stale_repository_graph');
  });
});

describe('a mechanism that broke', () => {
  it('reports a failed evidence acquisition as a fault the run survives', () => {
    const fallback = evaluateFallback({
      state: state(),
      decision: chooseEconomicAction({ state: state(), candidates: [] }),
      faults: ['evidence_mechanism_error'],
    });
    expect(fallback.mode).toBe('baseline');
    expect(mustBlockAction(fallback)).toBe(false);
  });

  it('reports invalid stored knowledge the same way', () => {
    const fallback = evaluateFallback({
      state: state(),
      decision: chooseEconomicAction({ state: state(), candidates: [] }),
      faults: ['invalid_memory'],
    });
    expect(fallback.mode).toBe('baseline');
  });

  it('survives a candidate source that throws, losing only its candidates', () => {
    registerCandidateSource('broken', () => { throw new Error('graph unavailable'); });
    const cycle = runDecisionCycle(state(), { nowMs: frozen });
    expect(cycle.decision).toBeDefined();
    expect(cycle.cost.reason).not.toBe('decision_engine_error');
  });

  it('survives a state the decision layer cannot read at all', () => {
    const broken = { ...state(), get trajectory(): never { throw new Error('nope'); } };
    const cycle = runDecisionCycle(broken as unknown as EconomicState, { nowMs: frozen });
    expect(cycle.cost.reason).toBe('decision_engine_error');
    expect(cycle.decision).toBeUndefined();

    // And the fault reaches the fallback as itself rather than as a crash.
    const fallback = evaluateFallback({ state: state(), faults: ['decision_engine_error'] });
    expect(fallback.mode).toBe('baseline');
  });
});

describe('a safety failure is refused, never merely un-optimized', () => {
  const unsafeOnly = () => [
    actionCandidate({
      id: 'unsafe', kind: 'recover', capability: 'recovery.retry',
      expectedTokenBenefit: 90_000, tokenCost: 100, metadata: { unsafe: true },
    }),
  ];

  it('never chooses the unsafe action however profitable it is', () => {
    const decision = chooseEconomicAction({ state: state(), candidates: unsafeOnly() });
    expect(decision.action.kind).toBe('continue');
  });

  it('sees the violation even when it was attributed to a rejected candidate', () => {
    // The case that matters most: every option was unsafe and the decision fell
    // through to continuing. A plain equality check on the reason codes would
    // miss it entirely.
    const decision = chooseEconomicAction({ state: state(), candidates: unsafeOnly() });
    const fallback = evaluateFallback({ state: state(), decision });
    expect(fallback.reasons).toContain('safety_violation');
  });

  it('tells the caller to block rather than to run unoptimized', () => {
    const decision = chooseEconomicAction({ state: state(), candidates: unsafeOnly() });
    const fallback = evaluateFallback({ state: state(), decision });
    // Falling back means running unoptimized, and the unsafe action is just as
    // unsafe unoptimized.
    expect(fallback.safetyPreserved).toBe(false);
    expect(mustBlockAction(fallback)).toBe(true);
  });

  it('outranks every ordinary fault beside it', () => {
    const decision = chooseEconomicAction({ state: state(), candidates: unsafeOnly() });
    const fallback = evaluateFallback({
      state: state(), decision, faults: ['missing_telemetry', 'invalid_memory'],
    });
    expect(mustBlockAction(fallback)).toBe(true);
  });
});

describe('failing to optimize never fails the work', () => {
  const broken: Array<[string, () => EconomicState]> = [
    ['no telemetry', () => state({ trajectory: { ...state().trajectory, orchestrationConfidence: 0 } })],
    ['no budget', () => state({ resources: { ...state().resources, consumedTokens: 100_000 } })],
    ['no optimization allowance', () => state({
      resources: { ...state().resources, optimizationTokens: 0 },
    })],
    ['everything at once', () => normalizeEconomicState({
      ...state(),
      resources: { ...state().resources, consumedTokens: 100_000, optimizationTokens: 0 },
      trajectory: { ...state().trajectory, orchestrationConfidence: 0 },
      evidence: [{ id: 'e', kind: 'fact', source: 's', confidence: 0.5, repositoryRevision: 'rev-0' }],
    })],
  ];

  it('produces a usable answer for every broken state', () => {
    for (const [name, build] of broken) {
      const s = build();
      const cycle = runDecisionCycle(s, { nowMs: frozen });
      const fallback = evaluateFallback({ state: s, decision: cycle.decision, faults: detectFaults(s) });
      // The run continues. That is the whole property.
      expect(fallback.mode, name).toBe('baseline');
      expect(mustBlockAction(fallback), name).toBe(false);
    }
  });

  it('never throws, whatever it is handed', () => {
    for (const [, build] of broken) {
      expect(() => evaluateFallback({ state: build(), faults: detectFaults(build()) })).not.toThrow();
    }
  });
});
