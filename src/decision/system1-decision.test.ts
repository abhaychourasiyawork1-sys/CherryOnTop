import { describe, it, expect } from 'vitest';
import { refineWithSystem1, helpfulnessMatters } from './system1-decision.js';
import { chooseEconomicAction } from './engine.js';
import { actionCandidate, type ActionCandidate } from './actions.js';
import { initialEconomicState, normalizeEconomicState, type EconomicState } from './state.js';
import { createSystem1 } from '../system1/guard.js';
import { ProviderFailure, type System1Provider } from '../system1/provider.js';
import type { DecisionJudgment, DecisionRequest } from '../system1/types.js';

function state(over: Partial<EconomicState['constraints']> = {}): EconomicState {
  const base = initialEconomicState({ goal: 'fix the parser', totalTokenBudget: 100_000, qualityFloor: 0.3 });
  return normalizeEconomicState({
    ...base, constraints: { ...base.constraints, ...over },
    trajectory: { ...base.trajectory, orchestrationConfidence: 0.8 },
  });
}

/** Answers helpfulness by a per-subject table and choices with a fixed id. */
function provider(helpful: (subject: string) => number, choose = 'option2') {
  const calls: DecisionRequest[][] = [];
  const p: System1Provider = {
    name: 'laya',
    async decide(rs) {
      calls.push([...rs]);
      return rs.map((r): DecisionJudgment => ({
        requestId: r.id, provider: 'laya', surface: r.surface, primitive: r.primitive,
        result: r.primitive === 'choice'
          ? { selectedId: choose, probabilities: Object.fromEntries(r.candidates.map((c) => [c.id, c.id === choose ? 0.9 : 0.1 / (r.candidates.length - 1)])) }
          : { probability: helpful(r.question) },
        calibration: { version: 'x' }, confidence: { provider: 0.5, orchestration: 0 },
        metadata: { model: 'm', questionVersion: r.questionVersion, inputDigest: r.inputDigest, stateVersion: r.stateVersion, latencyMs: 1, inputTokens: 10 },
      }));
    },
  };
  return { p, calls };
}

const validate = actionCandidate({ id: 'deep:validate', kind: 'validate', capability: 'v', confidence: 0.8, expectedQualityBenefit: 0.5, tokenCost: 4_000 });
const narrow = actionCandidate({ id: 'deep:constrain', kind: 'constrain', capability: 'c', confidence: 0.8, expectedTokenBenefit: 9_000, tokenCost: 0, qualityRisk: 0.02 });

async function refine(candidates: ActionCandidate[], p: System1Provider, st = state()) {
  const decision = chooseEconomicAction({ state: st, candidates, decisionId: 'd1' });
  return refineWithSystem1({ s1: createSystem1(p, { maxCallsPerScope: 10, timeoutMs: 1_000 }), scope: 'n', state: st, candidates, decision });
}

describe('System-1 in the next-action decision', () => {
  it('never asks about an action a hard constraint forbids', async () => {
    const { p, calls } = provider(() => 1);
    const r = await refine([validate, narrow], p, state({ hardStop: true }));
    expect(calls).toHaveLength(0);
    expect(r.decision.action.kind).toBe('stop');
  });

  it('never asks about continue or stop', () => {
    const cands = [actionCandidate({ id: 'continue', kind: 'continue', capability: 'x', confidence: 1 }), actionCandidate({ id: 'stop', kind: 'stop', capability: 'y', confidence: 1 })];
    expect(helpfulnessMatters(state(), cands, 0)).toBe(false);
    expect(helpfulnessMatters(state(), cands, 1)).toBe(false);
  });

  it('asks only where the answer could change the action, and batches those questions', async () => {
    const { p, calls } = provider(() => 0.5);
    const lone = await refine([validate], p);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    expect(lone.outcomes).toHaveLength(1);

    const both = provider(() => 0.5);
    await refine([validate, narrow], both.p);
    expect(both.calls).toHaveLength(1);
    expect(both.calls[0].every((r) => r.surface === 'action.helpful')).toBe(true);
  });

  it('a useless verdict removes the benefit, and the existing economics decides the rest', async () => {
    const { p } = provider(() => 0);
    const r = await refine([validate], p);
    expect(r.decision.action.kind).toBe('continue');
    expect(r.contexts[0].finalRuntimeAction).toBe('continue');
  });

  it('a Choice preference never overrides a utility difference', async () => {
    const { p, calls } = provider(() => 1, 'option2');
    const r = await refine([validate, narrow], p);
    const withoutChoice = chooseEconomicAction({ state: state(), candidates: [validate, narrow], decisionId: 'x' });
    expect(r.decision.action.id).toBe(withoutChoice.action.id);
    expect(calls.flat().some((q) => q.surface === 'runtime.next_action')).toBe(false);
  });

  it('breaks an exact economic tie by semantic preference instead of by id', async () => {
    const a = actionCandidate({ id: 'evidence:a.ts', kind: 'acquire_evidence', capability: 'e', confidence: 0.8, expectedTokenBenefit: 5_000, tokenCost: 500, metadata: { path: 'a.ts' } });
    const b = { ...a, id: 'evidence:b.ts', metadata: { path: 'b.ts' } };
    const baseline = chooseEconomicAction({ state: state(), candidates: [a, b], decisionId: 'x' });
    expect(baseline.reasonCodes).toContain('tie_broken_on_id');
    expect(baseline.action.id).toBe('evidence:a.ts');
    const { p } = provider(() => 1, 'option2');
    const r = await refine([a, b], p);
    expect(r.decision.action.id).toBe('evidence:b.ts');
    expect(r.decision.reasonCodes).toContain('tie_broken_by_system1');
  });

  it('keeps the deterministic decision when System-1 fails', async () => {
    const failing: System1Provider = { name: 'laya', decide: async () => { throw new ProviderFailure('timeout', 'slow'); } };
    const decision = chooseEconomicAction({ state: state(), candidates: [validate, narrow], decisionId: 'd1' });
    const r = await refine([validate, narrow], failing);
    expect(r.decision.action.id).toBe(decision.action.id);
    expect(r.outcomes.every((o) => o.failure?.kind === 'timeout')).toBe(true);
  });
});
