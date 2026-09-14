import { describe, it, expect } from 'vitest';
import {
  evaluateFallback, mustBlockAction, confidenceRequiredFor, FULL_ARCHITECTURE,
  type FallbackReason,
} from './fallback.js';
import { actionCandidate, type ActionDecision, type ActionKind } from './actions.js';
import { initialEconomicState, normalizeEconomicState, type EconomicState } from './state.js';

function state(over: Partial<EconomicState> = {}): EconomicState {
  const base = initialEconomicState({ goal: 'g', totalTokenBudget: 100_000, qualityFloor: 0.7 });
  return normalizeEconomicState({ ...base, ...over });
}

const decision = (over: Partial<ActionDecision> = {}, action: Partial<Parameters<typeof actionCandidate>[0]> = {}): ActionDecision => ({
  decisionId: 'd1',
  stateVersion: 1,
  utility: 0.5,
  reasonCodes: ['positive_utility'],
  confidence: 0.9,
  action: actionCandidate({
    id: 'a', kind: (action.kind ?? 'acquire_evidence') as ActionKind,
    capability: 'evidence.read-file', tokenCost: 500, ...action,
  }),
  ...over,
});

describe('a confident decision on a healthy state runs as Full Architecture', () => {
  it('does not fall back', () => {
    expect(evaluateFallback({ state: state(), decision: decision() })).toEqual(FULL_ARCHITECTURE);
  });

  it('reports no reason when nothing went wrong', () => {
    const result = evaluateFallback({ state: state(), decision: decision() });
    expect(result.reason).toBe('');
    expect(result.reasons).toEqual([]);
    expect(result.mode).toBe('full');
  });
});

describe('every ordinary fault lands in the same place', () => {
  const faults: FallbackReason[] = [
    'missing_telemetry', 'stale_repository_graph', 'invalid_memory',
    'decision_engine_error', 'evidence_mechanism_error',
  ];

  it('falls back to Baseline for each, and nowhere else', () => {
    for (const fault of faults) {
      const result = evaluateFallback({ state: state(), decision: decision(), faults: [fault] });
      // The whole point of having a Baseline: there is one fallback, not one
      // degraded mode per fault.
      expect(result.mode).toBe('baseline');
      expect(result.reasons).toEqual([fault]);
      expect(result.safetyPreserved).toBe(true);
      expect(mustBlockAction(result)).toBe(false);
    }
  });

  it('falls back when no decision was produced at all', () => {
    const result = evaluateFallback({ state: state() });
    expect(result.mode).toBe('baseline');
    expect(result.reasons).toContain('missing_telemetry');
  });

  it('falls back once the optimizer has spent its allowance', () => {
    const spent = state({
      resources: { ...state().resources, optimizationTokens: 1_000, optimizationConsumedTokens: 1_000 },
    });
    expect(evaluateFallback({ state: spent, decision: decision() }).reasons)
      .toContain('optimization_budget_exhausted');
  });

  it('records several faults together, deduplicated and ordered', () => {
    const result = evaluateFallback({
      state: state(),
      decision: decision(),
      faults: ['invalid_memory', 'missing_telemetry', 'invalid_memory'],
    });
    expect(result.reasons).toEqual(['invalid_memory', 'missing_telemetry']);
    expect(result.reason).toBe('invalid_memory; missing_telemetry');
  });

  it('gives two runs that failed the same way the same string to group on', () => {
    const a = evaluateFallback({ state: state(), decision: decision(), faults: ['invalid_memory', 'missing_telemetry'] });
    const b = evaluateFallback({ state: state(), decision: decision(), faults: ['missing_telemetry', 'invalid_memory'] });
    expect(a.reason).toBe(b.reason);
  });
});

describe('a safety failure is not a reason to fall back', () => {
  it('refuses the action rather than running it unoptimized', () => {
    const result = evaluateFallback({ state: state(), decision: decision(), faults: ['safety_violation'] });
    expect(result.mode).toBe('baseline');
    // Falling back means running unoptimized, and an action that violates a
    // hard safety constraint is just as unsafe unoptimized.
    expect(result.safetyPreserved).toBe(false);
    expect(mustBlockAction(result)).toBe(true);
  });

  it('sees a safety violation the decision itself reported', () => {
    const unsafe = decision({ reasonCodes: ['safety_violation', 'positive_utility'] });
    const result = evaluateFallback({ state: state(), decision: unsafe });
    expect(result.reasons).toContain('safety_violation');
    expect(mustBlockAction(result)).toBe(true);
  });

  it('does not record it twice when both the caller and the decision saw it', () => {
    const unsafe = decision({ reasonCodes: ['safety_violation'] });
    const result = evaluateFallback({ state: state(), decision: unsafe, faults: ['safety_violation'] });
    expect(result.reasons.filter((r) => r === 'safety_violation')).toHaveLength(1);
  });

  it('outranks an ordinary fault sitting beside it', () => {
    const result = evaluateFallback({
      state: state(), decision: decision(), faults: ['missing_telemetry', 'safety_violation'],
    });
    expect(mustBlockAction(result)).toBe(true);
  });
});

describe('confidence has to match what the action costs', () => {
  it('demands almost nothing of a free action', () => {
    const free = decision({}, { kind: 'constrain', tokenCost: 0 });
    expect(confidenceRequiredFor(free, state())).toBe(0);
  });

  it('demands most of the way to certainty of an expensive one', () => {
    const dear = decision({}, { tokenCost: 80_000 });
    expect(confidenceRequiredFor(dear, state())).toBeCloseTo(0.8);
  });

  it('falls back when the decision is not confident enough for what it would spend', () => {
    const dear = decision({ confidence: 0.3 }, { tokenCost: 80_000 });
    const result = evaluateFallback({ state: state(), decision: dear });
    expect(result.mode).toBe('baseline');
    expect(result.reasons).toContain('insufficient_confidence');
  });

  it('acts on the same confidence when the action is cheap', () => {
    const cheap = decision({ confidence: 0.3 }, { tokenCost: 1_000 });
    expect(evaluateFallback({ state: state(), decision: cheap }).mode).toBe('full');
  });

  it('shrinks the eligible set from the top down as confidence falls', () => {
    // This is what "orchestrator uncertainty reduces intervention
    // aggressiveness" means in code: the expensive interventions go first.
    const costs = [1_000, 20_000, 60_000, 90_000];
    const eligible = (confidence: number) => costs.filter((tokenCost) =>
      evaluateFallback({ state: state(), decision: decision({ confidence }, { tokenCost }) }).mode === 'full');
    expect(eligible(0.95).length).toBeGreaterThan(eligible(0.5).length);
    expect(eligible(0.5).length).toBeGreaterThan(eligible(0.05).length);
  });

  it('never demands confidence to continue or to stop', () => {
    for (const kind of ['continue', 'stop'] as ActionKind[]) {
      const doubtful = decision({ confidence: 0 }, { kind, tokenCost: 0 });
      expect(evaluateFallback({ state: state(), decision: doubtful }).mode).toBe('full');
    }
  });

  it('demands certainty when nothing is left to spend', () => {
    const broke = state({ resources: { ...state().resources, consumedTokens: 100_000 } });
    expect(confidenceRequiredFor(decision(), broke)).toBe(1);
  });
});

describe('totality', () => {
  it('is deterministic', () => {
    const input = { state: state(), decision: decision(), faults: ['invalid_memory'] as FallbackReason[] };
    expect(evaluateFallback(input)).toEqual(evaluateFallback(input));
  });

  it('handles an empty fault list as no faults', () => {
    expect(evaluateFallback({ state: state(), decision: decision(), faults: [] }).mode).toBe('full');
  });
});
