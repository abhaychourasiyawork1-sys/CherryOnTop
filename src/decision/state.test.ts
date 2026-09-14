import { describe, it, expect } from 'vitest';
import {
  applyEconomicEvent, normalizeEconomicState, initialEconomicState,
  type EconomicState, type EconomicEvent,
} from './state.js';

function base(over: Partial<EconomicState> = {}): EconomicState {
  return normalizeEconomicState({
    ...initialEconomicState({ goal: 'do the thing', totalTokenBudget: 1000 }),
    ...over,
  });
}

describe('normalizeEconomicState', () => {
  it('derives remainingTokens from the budget and what was consumed', () => {
    const state = base({ resources: { ...base().resources, totalTokenBudget: 1000, consumedTokens: 300, remainingTokens: 99999 } });
    expect(state.resources.remainingTokens).toBe(700);
  });

  it('never reports negative remaining resources', () => {
    const state = base({ resources: { ...base().resources, totalTokenBudget: 100, consumedTokens: 400 } });
    expect(state.resources.remainingTokens).toBe(0);
    expect(state.resources.consumedTokens).toBe(400);
  });

  it('clamps every uncertainty dimension into [0,1]', () => {
    const state = base({ uncertainty: { target: 4, structural: -2, behavioral: Number.NaN, validation: 0.5 } });
    expect(state.uncertainty).toEqual({ target: 1, structural: 0, behavioral: 0.5, validation: 0.5 });
  });

  it('clamps evidence confidence into [0,1] and drops non-finite token costs', () => {
    const state = base({
      evidence: [
        { id: 'a', kind: 'fact', source: 'read:src/a.ts', confidence: 3, tokenCost: Number.NaN },
        { id: 'b', kind: 'hypothesis', source: 'guess', confidence: -1, tokenCost: 12 },
      ],
    });
    expect(state.evidence.map((e) => e.confidence)).toEqual([1, 0]);
    expect(state.evidence[0].tokenCost).toBe(0);
    expect(state.evidence[1].tokenCost).toBe(12);
  });

  it('keeps the quality floor inside [0,1] and never invents one above what was set', () => {
    expect(base({ constraints: { qualityFloor: 0.8, hardStop: false } }).constraints.qualityFloor).toBe(0.8);
    expect(base({ constraints: { qualityFloor: 5, hardStop: false } }).constraints.qualityFloor).toBe(1);
  });

  it('bounds the optimization allowance by the total budget', () => {
    const state = base({ resources: { ...base().resources, totalTokenBudget: 500, optimizationTokens: 9000 } });
    expect(state.resources.optimizationTokens).toBeLessThanOrEqual(500);
  });

  it('is idempotent', () => {
    const once = base({ uncertainty: { target: 0.7, structural: 0.2, behavioral: 0.4, validation: 0.9 } });
    expect(normalizeEconomicState(once)).toEqual(once);
  });
});

describe('applyEconomicEvent', () => {
  const started: EconomicEvent = {
    kind: 'TASK_STARTED',
    goal: 'add a test for scoreDelegation',
    repositoryRevision: 'abc123',
    totalTokenBudget: 10_000,
    optimizationTokens: 500,
    qualityFloor: 0.7,
    availableCapabilities: ['context.select', 'validation.unit-tests'],
  };

  it('increments the version on every applied event', () => {
    const a = base();
    const b = applyEconomicEvent(a, started);
    const c = applyEconomicEvent(b, { kind: 'PROGRESS_UPDATED', progress: 0.4 });
    expect(b.version).toBe(a.version + 1);
    expect(c.version).toBe(b.version + 1);
  });

  it('never mutates the previous snapshot', () => {
    const a = base();
    const snapshot = structuredClone(a);
    applyEconomicEvent(a, { kind: 'EVIDENCE_ACQUIRED', evidence: [{ id: 'e1', kind: 'fact', source: 's', confidence: 0.9 }], tokenCost: 50 });
    expect(a).toEqual(snapshot);
  });

  it('updates only the dimensions the event touches', () => {
    const a = applyEconomicEvent(base(), started);
    const b = applyEconomicEvent(a, { kind: 'PROGRESS_UPDATED', progress: 0.6 });
    expect(b.trajectory.progress).toBe(0.6);
    expect(b.uncertainty).toEqual(a.uncertainty);
    expect(b.resources.consumedTokens).toBe(a.resources.consumedTokens);
    expect(b.evidence).toEqual(a.evidence);
    expect(b.constraints).toEqual(a.constraints);
  });

  it('TASK_STARTED seeds the goal, budget, capabilities and quality floor', () => {
    const s = applyEconomicEvent(base(), started);
    expect(s.goal).toBe('add a test for scoreDelegation');
    expect(s.repositoryRevision).toBe('abc123');
    expect(s.resources.totalTokenBudget).toBe(10_000);
    expect(s.resources.remainingTokens).toBe(10_000);
    expect(s.constraints.qualityFloor).toBe(0.7);
    expect(s.availableCapabilities).toEqual(['context.select', 'validation.unit-tests']);
  });

  it('EVIDENCE_ACQUIRED appends evidence and charges its acquisition cost', () => {
    const a = applyEconomicEvent(base(), started);
    const b = applyEconomicEvent(a, {
      kind: 'EVIDENCE_ACQUIRED',
      evidence: [{ id: 'e1', kind: 'fact', source: 'read:src/a.ts', confidence: 0.9, repositoryRevision: 'abc123' }],
      tokenCost: 120,
    });
    expect(b.evidence).toHaveLength(1);
    expect(b.resources.consumedTokens).toBe(120);
    expect(b.resources.remainingTokens).toBe(9880);
  });

  it('EVIDENCE_ACQUIRED does not duplicate evidence already held', () => {
    const one: EconomicEvent = {
      kind: 'EVIDENCE_ACQUIRED',
      evidence: [{ id: 'e1', kind: 'fact', source: 'read:src/a.ts', confidence: 0.9 }],
      tokenCost: 100,
    };
    const a = applyEconomicEvent(applyEconomicEvent(base(), started), one);
    const b = applyEconomicEvent(a, one);
    expect(b.evidence).toHaveLength(1);
    // Re-delivery of the same evidence must not charge twice either.
    expect(b.resources.consumedTokens).toBe(a.resources.consumedTokens);
  });

  it('EVIDENCE_ACQUIRED can reduce the uncertainty dimensions it names and no others', () => {
    const a = applyEconomicEvent(base(), started);
    const b = applyEconomicEvent(a, {
      kind: 'EVIDENCE_ACQUIRED',
      evidence: [{ id: 'e1', kind: 'observation', source: 'grep', confidence: 0.8 }],
      tokenCost: 10,
      uncertainty: [{ kind: 'structural', before: a.uncertainty.structural, after: 0.2, sourceEvidenceIds: ['e1'], confidence: 0.8 }],
    });
    expect(b.uncertainty.structural).toBeLessThan(a.uncertainty.structural);
    expect(b.uncertainty.behavioral).toBe(a.uncertainty.behavioral);
  });

  it('EXECUTION_STEP_COMPLETED charges tokens without touching evidence', () => {
    const a = applyEconomicEvent(base(), started);
    const b = applyEconomicEvent(a, { kind: 'EXECUTION_STEP_COMPLETED', tokenCost: 2500, latencyMs: 8000, succeeded: true });
    expect(b.resources.consumedTokens).toBe(2500);
    expect(b.evidence).toEqual(a.evidence);
  });

  it('FAILURE_DETECTED raises failure pressure without claiming the task failed', () => {
    const a = applyEconomicEvent(base(), started);
    const b = applyEconomicEvent(a, { kind: 'FAILURE_DETECTED', signature: 'tsc:TS2345', tokenCost: 40 });
    expect(b.trajectory.failurePressure).toBeGreaterThan(a.trajectory.failurePressure);
    expect(b.constraints.hardStop).toBe(false);
  });

  it('INTERVENTION_DECIDED charges the orchestration budget, not the task budget', () => {
    const a = applyEconomicEvent(base(), started);
    const b = applyEconomicEvent(a, { kind: 'INTERVENTION_DECIDED', decisionId: 'd1', action: 'continue', orchestrationCost: 35 });
    expect(b.resources.optimizationConsumedTokens).toBe(35);
    expect(b.resources.consumedTokens).toBe(a.resources.consumedTokens);
  });

  it('VALIDATION_RESULT records status and drives validation uncertainty', () => {
    const a = applyEconomicEvent(base(), started);
    const passed = applyEconomicEvent(a, { kind: 'VALIDATION_RESULT', passed: true, confidence: 0.9, tokenCost: 300, evidenceIds: [] });
    expect(passed.validation.status).toBe('passed');
    expect(passed.validation.confidence).toBe(0.9);
    expect(passed.uncertainty.validation).toBeLessThan(a.uncertainty.validation);

    const failed = applyEconomicEvent(a, { kind: 'VALIDATION_RESULT', passed: false, confidence: 0.9, tokenCost: 300, evidenceIds: [] });
    expect(failed.validation.status).toBe('failed');
    expect(failed.trajectory.failurePressure).toBeGreaterThan(a.trajectory.failurePressure);
  });

  it('BUDGET_UPDATED can raise the budget but never lowers the quality floor', () => {
    const a = applyEconomicEvent(base(), started);
    const b = applyEconomicEvent(a, { kind: 'BUDGET_UPDATED', totalTokenBudget: 20_000, recoveryReserve: 1000 });
    expect(b.resources.totalTokenBudget).toBe(20_000);
    expect(b.resources.recoveryReserve).toBe(1000);
    expect(b.constraints.qualityFloor).toBe(a.constraints.qualityFloor);
  });

  it('terminal events set the hard stop', () => {
    const a = applyEconomicEvent(base(), started);
    expect(applyEconomicEvent(a, { kind: 'TASK_COMPLETED', succeeded: true }).constraints.hardStop).toBe(true);
    expect(applyEconomicEvent(a, { kind: 'TASK_FAILED', reason: 'nope' }).constraints.hardStop).toBe(true);
  });

  it('keeps every invariant after an arbitrary event sequence', () => {
    const events: EconomicEvent[] = [
      started,
      { kind: 'EVIDENCE_ACQUIRED', evidence: [{ id: 'e1', kind: 'fact', source: 's', confidence: 0.9 }], tokenCost: 400 },
      { kind: 'EXECUTION_STEP_COMPLETED', tokenCost: 9000, latencyMs: 1000, succeeded: false },
      { kind: 'FAILURE_DETECTED', signature: 'x', tokenCost: 5000 },
      { kind: 'PROGRESS_UPDATED', progress: 2 },
      { kind: 'TRAJECTORY_STATE_CHANGED', trajectory: { explorationPressure: -3, stateSimilarity: 9 } },
    ];
    const final = events.reduce(applyEconomicEvent, base());
    expect(final.resources.remainingTokens).toBe(0);
    expect(final.trajectory.progress).toBe(1);
    expect(final.trajectory.explorationPressure).toBe(0);
    expect(final.trajectory.stateSimilarity).toBe(1);
    expect(final.version).toBe(events.length);
  });

  it('an unrecognised event is a no-op that still advances the version', () => {
    const a = applyEconomicEvent(base(), started);
    const b = applyEconomicEvent(a, { kind: 'NOT_A_REAL_EVENT' } as unknown as EconomicEvent);
    expect(b.version).toBe(a.version + 1);
    expect({ ...b, version: a.version }).toEqual(a);
  });
});
