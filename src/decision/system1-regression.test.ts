/** Characterization of the control plane *before* System-1 owns any semantic
 *  decision. Every assertion here describes behaviour that already exists and
 *  must survive the Laya integration unchanged: if one of these starts failing,
 *  a semantic judgment has leaked into a place that was supposed to stay
 *  deterministic. */
import { describe, it, expect } from 'vitest';
import { chooseEconomicAction, authorizeExecution, hardGates } from './engine.js';
import { actionCandidate } from './actions.js';
import { initialEconomicState, normalizeEconomicState, type EconomicState } from './state.js';
import { decideExecution } from '../engines/decide-execution.js';
import { nextAfterValidation, MAX_EXECUTION_ATTEMPTS } from '../validation/engine.js';
import { selectContext } from '../context/selector.js';
import { createContextScorer } from '../context/scoring.js';
import type { ContextCandidate } from '../context/candidates.js';
import type { Authority } from '../schemas/node-contract.js';
import type { ValidationResult } from '../validation/engine.js';

function state(over: Partial<EconomicState> = {}): EconomicState {
  const base = initialEconomicState({ goal: 'g', totalTokenBudget: 10_000, qualityFloor: 0.5 });
  return normalizeEconomicState({ ...base, ...over, constraints: { ...base.constraints, ...over.constraints } });
}

const authority = (over: Partial<Authority> = {}): Authority => ({
  budget_usd: 5, spawn_children: true, max_child_count: 4, tools: [], ...over,
} as Authority);

const passing: ValidationResult = {
  level: 'V2', passed: true, confidence: 0.85, tokens: 0, latencyMs: 0,
  evidenceIds: ['observed:npm test'], reasonCodes: ['V2:observed_verification_passed'],
};

describe('System-1 preservation: hard control stays deterministic', () => {
  it('a hard stop cannot be overridden by any amount of positive evidence', () => {
    const overwhelming = actionCandidate({
      id: 'x', kind: 'validate', capability: 'c', confidence: 1,
      expectedQualityBenefit: 1, expectedTokenBenefit: 1_000_000, tokenCost: 0,
    });
    const d = chooseEconomicAction({
      state: state({ constraints: { hardStop: true } as EconomicState['constraints'] }),
      candidates: [overwhelming],
      decisionId: 'd',
    });
    expect(d.action.kind).toBe('stop');
    expect(d.reasonCodes).toContain('hard_stop');
  });

  it('no spawn authority means self-execution before any splitting signal is read', () => {
    const r = decideExecution({
      goal: 'split this across 4 agents in parallel', authority: authority({ spawn_children: false }),
      complexity: 'high', worthSplitting: true,
    });
    expect(r.outcome).toBe('SELF_EXECUTE');
    expect(r.breakdown.reason_no_spawn_authority).toBe(1);
  });

  it('the market vetoes delegation under a hard stop even when economics wants it', () => {
    const economics = decideExecution({ goal: 'g', authority: authority(), complexity: 'high', worthSplitting: true });
    expect(economics.outcome).toBe('DELEGATE');
    const authorized = authorizeExecution({
      state: state({ constraints: { hardStop: true } as EconomicState['constraints'] }),
      economics, dispatch: { tokens: 1000, latencyMs: 60_000, costUsd: 0.1 }, plannedChildCount: 4,
    });
    expect(authorized.outcome).toBe('SELF_EXECUTE');
  });

  it('an exhausted budget is a gate, not a score', () => {
    const gated = hardGates({ authority: authority({ budget_usd: 1 }), spentUsd: 1 });
    expect(gated?.chosen).toBe('STOP');
    expect(gated?.gate).toBe('budget');
  });
});

describe('System-1 preservation: validation is the only door to COMPLETE', () => {
  it('execution success alone is not completion', () => {
    expect(nextAfterValidation({
      executionSucceeded: true, validation: { ...passing, passed: false }, executionAttempts: 0,
    })).not.toBe('COMPLETE');
  });

  it('a passing validation of a failed execution is not completion', () => {
    expect(nextAfterValidation({ executionSucceeded: false, validation: passing, executionAttempts: 0 })).not.toBe('COMPLETE');
  });

  it('retries are bounded, and a rate limit is never retried', () => {
    const failed = { ...passing, passed: false };
    expect(nextAfterValidation({ executionSucceeded: false, validation: failed, executionAttempts: MAX_EXECUTION_ATTEMPTS })).toBe('FAILED');
    expect(nextAfterValidation({ executionSucceeded: false, validation: failed, executionAttempts: 0, retriable: false })).toBe('FAILED');
  });
});

describe('System-1 preservation: context selection obeys its ceiling', () => {
  it('never selects more tokens than the budget allows', () => {
    const many: ContextCandidate[] = Array.from({ length: 100 }, (_, i) => ({
      key: `src/f${i}.ts`, path: `src/f${i}.ts`, symbols: [], evidenceLevel: 'L1', estimatedTokens: 40,
      lexicalScore: 2, structuralScore: 1, taskFitScore: 0.5, confidenceScore: 0.7,
      reuseScore: 0, relationships: [`imports:src/x${i}.ts`], materialization: 'inventory',
    }));
    const result = selectContext({
      candidates: many, scorer: createContextScorer(),
      policy: { tokenBudget: 250, optimizationBudget: 100, confidenceFloor: 0 },
    });
    expect(result.estimatedTokens).toBeLessThanOrEqual(250);
  });
});
