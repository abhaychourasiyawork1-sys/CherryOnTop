/** Fault injection through the real path.
 *
 *  These run the real market with something broken and assert what reaches the
 *  other side: that the run continues, that it continues as the null action
 *  (there is no second architecture to fall back to), and that an unsafe action
 *  is refused rather than merely un-optimized.
 *
 *  The property under test is the one that decides whether an optimizer is safe
 *  to deploy at all: **failing to optimize must never fail the work.** */
import { describe, it, expect, afterEach } from 'vitest';
import { runDecisionCycle } from './orchestration-loop.js';
import { registerCandidateSource, registeredCandidateSources } from './deep-path.js';
import { detectFaults } from './fallback.js';
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

/** A struggling run with an intervention on offer that would clearly pay —
 *  so standing down is visibly the fault's doing, not the economics'. */
const tempting = () => [actionCandidate({
  id: 'retry', kind: 'recover', capability: 'recovery.retry',
  expectedProgress: 0.8, expectedTokenBenefit: 60_000, tokenCost: 2_000, confidence: 0.9,
})];

function standsDown(s: EconomicState, faults: Parameters<typeof chooseEconomicAction>[0]['faults'] = detectFaults(s)) {
  const decision = chooseEconomicAction({ state: s, candidates: tempting(), faults });
  expect(decision.action.kind).toBe('continue');
  return decision;
}

describe('missing telemetry', () => {
  it('is detected as a fault rather than read as a healthy run', () => {
    const blind = state({ trajectory: { ...state().trajectory, orchestrationConfidence: 0 } });
    expect(detectFaults(blind)).toContain('missing_telemetry');
  });

  it('stands down to the null action rather than acting on a run it cannot read', () => {
    const blind = state({ trajectory: { ...state().trajectory, orchestrationConfidence: 0 } });
    const decision = standsDown(blind);
    expect(decision.reasonCodes).toContain('rejected:retry:fault:missing_telemetry');
    // The same intervention, on a readable run, is taken.
    expect(chooseEconomicAction({ state: state(), candidates: tempting() }).action.id).toBe('retry');
  });

  it('continues through the loop too, without a second mode to be in', () => {
    const blind = state({ trajectory: { ...state().trajectory, orchestrationConfidence: 0 } });
    const cycle = runDecisionCycle(blind, { nowMs: frozen, additionalCandidates: tempting() });
    expect(cycle.decision?.action.kind).toBe('continue');
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
    const untagged = state({
      evidence: [{ id: 'e1', kind: 'observation', source: 'grep', confidence: 0.6 }],
    });
    expect(detectFaults(untagged)).not.toContain('stale_repository_graph');
  });

  it('does not flag a run with no revision of its own to compare against', () => {
    const unknown = normalizeEconomicState({ ...stale(), repositoryRevision: undefined });
    expect(detectFaults(unknown)).not.toContain('stale_repository_graph');
  });

  it('does not intervene on a tree that has moved', () => {
    expect(standsDown(stale()).reasonCodes).toContain('rejected:retry:fault:stale_repository_graph');
  });
});

describe('a mechanism that broke', () => {
  it('stands down on a failed evidence acquisition, and the run continues', () => {
    standsDown(state(), ['evidence_mechanism_error']);
  });

  it('stands down on invalid stored knowledge the same way', () => {
    standsDown(state(), ['invalid_memory']);
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

  it('names the refusal on the decision, attributed to the candidate', () => {
    const decision = chooseEconomicAction({ state: state(), candidates: unsafeOnly() });
    expect(decision.reasonCodes).toContain('rejected:unsafe:safety_violation');
    expect(decision.rejected?.[0]).toEqual(expect.objectContaining({ id: 'unsafe' }));
  });

  it('still refuses it when a fault would have made it infeasible anyway', () => {
    const decision = chooseEconomicAction({
      state: state(), candidates: unsafeOnly(), faults: ['missing_telemetry', 'invalid_memory'],
    });
    expect(decision.action.id).not.toBe('unsafe');
    expect(decision.reasonCodes).toContain('rejected:unsafe:safety_violation');
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

  it('produces a usable, non-blocking answer for every broken state', () => {
    for (const [name, build] of broken) {
      const cycle = runDecisionCycle(build(), { nowMs: frozen });
      // The run continues — never a stop, never a block. That is the whole
      // property. (A spent budget is not a fault: a free intervention may
      // still be worth taking.)
      expect(cycle.decision, name).toBeDefined();
      expect(cycle.decision?.action.kind, name).not.toBe('stop');
      expect(cycle.decision?.blocked, name).toBe(false);
      if (detectFaults(build()).length > 0) expect(cycle.decision?.action.kind, name).toBe('continue');
    }
  });

  it('never throws, whatever it is handed', () => {
    for (const [, build] of broken) {
      expect(() => chooseEconomicAction({ state: build(), candidates: tempting(), faults: detectFaults(build()) })).not.toThrow();
    }
  });
});
