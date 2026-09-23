import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  runDecisionCycle, decisionCycleInProgress, INITIAL_CADENCE, MAX_CADENCE_INTERVAL,
} from './orchestration-loop.js';
import {
  orchestrationCostOf, FAST_PATH_TOKEN_COST, DEEP_PATH_TOKEN_COST, PER_CANDIDATE_TOKEN_COST,
} from './orchestration-cost.js';
import { registerCandidateSource, registeredCandidateSources } from './deep-path.js';
import { actionCandidate } from './actions.js';
import { initialEconomicState, normalizeEconomicState, type EconomicState } from './state.js';

/** A clock that does not move, so a cycle is reproducible. */
const frozen = () => 1_000;

function state(over: Partial<EconomicState> = {}): EconomicState {
  const base = initialEconomicState({ goal: 'g', totalTokenBudget: 100_000, qualityFloor: 0.7 });
  return normalizeEconomicState({ ...base, ...over });
}

/** A run that is going well: doubt resolved, evidence in hand, progress real,
 *  nothing repeating, money proportional to work done. */
function healthy(over: Partial<EconomicState> = {}): EconomicState {
  const base = state();
  return state({
    version: 10,
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
    resources: { ...base.resources, consumedTokens: 30_000 },
    validation: { required: true, confidence: 0.9, status: 'passed' },
    ...over,
  });
}

/** A run in trouble: failing, and getting nowhere for it. */
const struggling = (over: Partial<EconomicState> = {}) => healthy({
  trajectory: { ...healthy().trajectory, failurePressure: 0.9, progress: 0.1 },
  ...over,
});

const cycle = (s: EconomicState, over = {}) => runDecisionCycle(s, { nowMs: frozen, ...over });

afterEach(() => {
  for (const name of registeredCandidateSources()) registerCandidateSource(name, () => [])();
});

describe('the cheap case, which is most of them', () => {
  it('does not evaluate deeply when the screen sees nothing', () => {
    const spy = vi.fn(() => []);
    registerCandidateSource('watcher', spy);
    const result = cycle(healthy());
    expect(result.skippedDeepEvaluation).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('still produces an explicit decision, so "we looked" is distinguishable from "we did not"', () => {
    const result = cycle(healthy());
    expect(result.decision?.action.kind).toBe('continue');
    expect(result.decision?.stateVersion).toBe(10);
  });

  it('charges only the screen for it', () => {
    expect(cycle(healthy()).cost).toEqual({
      tokens: FAST_PATH_TOKEN_COST, latencyMs: 0, reason: 'fast-path',
    });
  });
});

describe('the case worth paying for', () => {
  it('evaluates deeply once the screen sees a material opportunity', () => {
    const result = cycle(struggling());
    expect(result.skippedDeepEvaluation).toBe(false);
    expect(result.inspection?.reasons).toContain('repeated_failure');
    expect(result.candidates.map((c) => c.kind)).toContain('recover');
  });

  it('charges the screen, the evaluation and every candidate it considered', () => {
    const result = cycle(struggling());
    expect(result.cost.reason).toBe('fast-path+deep-path');
    expect(result.cost.tokens).toBe(
      FAST_PATH_TOKEN_COST + DEEP_PATH_TOKEN_COST + result.candidates.length * PER_CANDIDATE_TOKEN_COST,
    );
  });

  it('returns a decision drawn from the candidates it built', () => {
    registerCandidateSource('evidence', () => [
      actionCandidate({
        id: 'ev:1', kind: 'acquire_evidence', capability: 'evidence.read-file',
        expectedTokenBenefit: 60_000, tokenCost: 500, confidence: 1,
      }),
    ]);
    const result = cycle(struggling());
    expect(result.decision?.action.id).toBe('ev:1');
  });
});

describe('adaptive reassessment frequency', () => {
  it('looks on the first cycle whatever the version is', () => {
    expect(cycle(healthy({ version: 9_999 })).cost.reason).toBe('fast-path');
  });

  it('backs off while the run stays quiet', () => {
    let cadence = INITIAL_CADENCE;
    const intervals: number[] = [];
    for (let version = 10; version < 60; version++) {
      const result = cycle(healthy({ version }), { cadence });
      cadence = result.cadence;
      if (result.decision) intervals.push(cadence.interval);
    }
    expect(intervals).toEqual([2, 4, 8, 16, 16, 16]);
  });

  it('skips a cycle that is not due, and skipping is free', () => {
    const first = cycle(healthy({ version: 10 }));
    const tooSoon = cycle(healthy({ version: 10 }), { cadence: first.cadence });
    expect(tooSoon.cost).toEqual({ tokens: 0, latencyMs: 0, reason: 'not_due' });
    expect(tooSoon.decision).toBeUndefined();
  });

  it('collapses the interval the moment the run stops looking quiet', () => {
    registerCandidateSource('evidence', () => [
      actionCandidate({
        id: 'ev:1', kind: 'acquire_evidence', capability: 'evidence.read-file',
        expectedTokenBenefit: 60_000, tokenCost: 500, confidence: 1,
      }),
    ]);
    const backedOff = { lastEvaluatedVersion: 0, interval: 16, consecutiveNoOps: 8 };
    const result = cycle(struggling({ version: 20 }), { cadence: backedOff });
    expect(result.decision?.action.kind).not.toBe('continue');
    expect(result.cadence.interval).toBe(1);
    expect(result.cadence.consecutiveNoOps).toBe(0);
  });

  it('treats a deep cycle that found nothing actionable as quiet', () => {
    // Otherwise one persistent weak signal would buy a deep evaluation on every
    // event, forever.
    const result = cycle(struggling({ version: 20 }));
    if (result.decision?.action.kind === 'continue') {
      expect(result.cadence.interval).toBeGreaterThan(1);
    }
  });

  it('never backs off past the ceiling', () => {
    let cadence = { lastEvaluatedVersion: 0, interval: MAX_CADENCE_INTERVAL, consecutiveNoOps: 40 };
    cadence = cycle(healthy({ version: 1_000 }), { cadence }).cadence;
    expect(cadence.interval).toBe(MAX_CADENCE_INTERVAL);
  });
});

describe('the loop cannot optimize itself', () => {
  it('refuses a cycle started inside a cycle', () => {
    let inner: ReturnType<typeof runDecisionCycle> | undefined;
    let sawGuard = false;
    registerCandidateSource('recursive', (s) => {
      sawGuard = decisionCycleInProgress();
      inner = runDecisionCycle(s, { nowMs: frozen });
      return [];
    });
    cycle(struggling());
    expect(sawGuard).toBe(true);
    expect(inner?.cost.reason).toBe('reentrant');
    expect(inner?.decision).toBeUndefined();
  });

  it('clears the guard afterwards', () => {
    cycle(struggling());
    expect(decisionCycleInProgress()).toBe(false);
  });
});

describe('failing to orchestrate never fails the run', () => {
  it('reports a skipped cycle rather than throwing', () => {
    const broken = { ...struggling(), get trajectory(): never { throw new Error('nope'); } };
    const result = runDecisionCycle(broken as unknown as EconomicState, { nowMs: frozen });
    expect(result.cost.reason).toBe('decision_engine_error');
    expect(result.decision).toBeUndefined();
    expect(decisionCycleInProgress()).toBe(false);
  });

  it('does no deep evaluation on a task that is already over', () => {
    const done = struggling({ constraints: { qualityFloor: 0.7, hardStop: true } });
    const result = cycle(done);
    expect(result.skippedDeepEvaluation).toBe(true);
    expect(result.decision?.action.kind).toBe('stop');
  });
});

describe('orchestrationCostOf', () => {
  it('charges nothing for work not done', () => {
    expect(orchestrationCostOf({ fastPath: false, deepPath: false, candidates: 0, latencyMs: 5 }))
      .toEqual({ tokens: 0, latencyMs: 5, reason: 'skipped' });
  });

  it('charges the screen alone when only the screen ran', () => {
    expect(orchestrationCostOf({ fastPath: true, deepPath: false, candidates: 0, latencyMs: 0 }).tokens)
      .toBe(FAST_PATH_TOKEN_COST);
  });

  it('charges per candidate considered', () => {
    const one = orchestrationCostOf({ fastPath: true, deepPath: true, candidates: 1, latencyMs: 0 }).tokens;
    const five = orchestrationCostOf({ fastPath: true, deepPath: true, candidates: 5, latencyMs: 0 }).tokens;
    expect(five - one).toBe(4 * PER_CANDIDATE_TOKEN_COST);
  });

  it('never reports negative latency', () => {
    expect(orchestrationCostOf({ fastPath: true, deepPath: false, candidates: 0, latencyMs: -9 }).latencyMs).toBe(0);
  });
});
