import { describe, it, expect, vi } from 'vitest';
import { decideStrategy, deterministicEvidence, sanitizeClassification, type StrategyClassifier } from './strategy-gate.js';
import { prepareDispatch } from './dispatch-preparation.js';
import type { Authority } from '../schemas/node-contract.js';

const WIDE: Authority = { tools: ['read', 'edit'], spawn_children: true, max_child_count: 3, budget_usd: 10 };

function prep(goal: string, authority: Authority = WIDE, splitProbability?: number) {
  return prepareDispatch({
    goal, authority, toolGrant: { allowedTools: null, readOnly: false },
    ...(splitProbability === undefined ? {} : {
      understanding: { readOnly: false, anchors: [], splitProbability },
    }),
  });
}

const DISPATCH = { tokens: 100_000, latencyMs: 120_000, costUsd: 0.5 };

function decide(goal: string, over: Partial<Parameters<typeof decideStrategy>[0]> = {}, splitProbability?: number) {
  return decideStrategy({
    preparation: prep(goal, WIDE, splitProbability), spentUsd: 0, dispatch: DISPATCH, outcome: 'SELF_EXECUTE', ...over,
  });
}

describe('typed evidence', () => {
  it('does not invoke the classifier when System-1 has said the work is one unit', () => {
    const classify = vi.fn<StrategyClassifier>();
    const decision = decide('Fix the typo in README.md', { classify, outcome: 'DELEGATE' }, 0.1);
    expect(classify).not.toHaveBeenCalled();
    expect(decision.evidence.deterministic).toBe(true);
    expect(decision.evidence.partitionability).toBe('NO');
    expect(decision.evidence.reasonCodes).toContain('system1_says_single_unit');
  });

  it('does not invoke the classifier when System-1 has said the work splits', () => {
    const classify = vi.fn<StrategyClassifier>();
    const decision = decide('Fix the auth bug, and also add tests for the parser',
      { classify, parallelSelected: true, outcome: 'DELEGATE' }, 0.9);
    expect(classify).not.toHaveBeenCalled();
    expect(decision.evidence.partitionability).toBe('YES');
  });

  it('reads nothing off the wording: the same goal is uncertain until System-1 answers', () => {
    const goal = 'Split this across multiple agents: tidy src/a.ts';
    expect(deterministicEvidence(prep(goal)).partitionability).toBe('UNCERTAIN');
    expect(deterministicEvidence(prep(goal)).reasonCodes).toContain('no_split_judgment');
    expect(deterministicEvidence(prep(goal, WIDE, 0.8)).partitionability).toBe('YES');
  });

  it('carries the doubt in the probability as its confidence', () => {
    expect(deterministicEvidence(prep('x', WIDE, 0.5)).confidence).toBeCloseTo(0);
    expect(deterministicEvidence(prep('x', WIDE, 0.95)).confidence).toBeCloseTo(0.9);
  });
});

describe('classifier stage', () => {
  const ambiguous = 'Bring the whole service in line with the new error handling approach';

  it('is bought exactly once, and only when partitionability is unknown and the market split the work', () => {
    expect(deterministicEvidence(prep(ambiguous)).partitionability).toBe('UNCERTAIN');
    const classify = vi.fn<StrategyClassifier>(() => ({
      partitionability: 'YES', parallelism: 'HIGH', confidence: 0.8,
    }));
    const decision = decide(ambiguous, { classify, outcome: 'DELEGATE' });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(decision.evidence.deterministic).toBe(false);
    expect(decision.evidence.reasonCodes).toContain('classifier_consulted');
  });

  it('is never bought to name a strategy the market is not taking', () => {
    const classify = vi.fn<StrategyClassifier>();
    decide(ambiguous, { classify, outcome: 'SELF_EXECUTE' });
    expect(classify).not.toHaveBeenCalled();
  });

  it('drops child counts, budgets and subgoals a classifier tries to return', () => {
    const sanitized = sanitizeClassification({
      partitionability: 'YES', parallelism: 'HIGH', confidence: 0.9,
      childCount: 4, subgoals: ['a', 'b'], budgetUsd: 3,
    });
    expect(sanitized).not.toBeNull();
    expect(sanitized).not.toHaveProperty('childCount');
    expect(sanitized).not.toHaveProperty('subgoals');
    expect(sanitized).not.toHaveProperty('budgetUsd');
    expect(sanitized!.reasonCodes).toEqual(expect.arrayContaining([
      'classifier_overreach_dropped:childCount',
      'classifier_overreach_dropped:subgoals',
      'classifier_overreach_dropped:budgetUsd',
    ]));
  });

  it('rejects a classification that is not the shape it promised', () => {
    expect(sanitizeClassification({ partitionability: 'maybe' })).toBeNull();
    expect(sanitizeClassification(null)).toBeNull();
    expect(sanitizeClassification('YES')).toBeNull();
  });

  it('falls back to deterministic behaviour when the classifier throws', () => {
    const classify = vi.fn<StrategyClassifier>(() => { throw new Error('classifier down'); });
    const decision = decide(ambiguous, { classify, outcome: 'DELEGATE' });
    expect(decision.strategy).toBeDefined();
    expect(decision.evidence.reasonCodes).toContain('deterministic_fallback');
    expect(decision.evidence.reasonCodes.some((c) => c.startsWith('classifier_failed'))).toBe(true);
  });

  it('records a receipt explaining the fallback', () => {
    const decision = decide(ambiguous, { classify: () => { throw new Error('nope'); }, outcome: 'DELEGATE' });
    expect(decision.receipt.chosen).toBeDefined();
    expect(decision.evidence.reasonCodes.join(',')).toMatch(/deterministic_fallback/);
  });
});

describe('naming the market’s choice', () => {
  it('names the market’s outcome and never recomputes delegation economics', () => {
    // The market decided to do this directly; the gate must not second-guess
    // it however splittable the goal looks.
    const goal = 'Fix the auth bug, and also add tests for the parser';
    const direct = decide(goal, { outcome: 'SELF_EXECUTE', parallelSelected: true });
    expect(direct.strategy).toBe('MANAGED');
    expect(direct.evidence.reasonCodes).toContain('market:SELF_EXECUTE');
  });

  it('reaches SERIAL_DELEGATED when the work splits but parallelism is not justified', () => {
    const decision = decide('Fix the auth bug, and also add tests for the parser', { outcome: 'DELEGATE', parallelSelected: false });
    expect(decision.strategy).toBe('SERIAL_DELEGATED');
    expect(decision.evidence.reasonCodes).toContain('delegate_serial:scheduler_did_not_select_parallel');
  });

  it('reaches PARALLEL_DELEGATED only when the scheduler selected parallel work', () => {
    const goal = 'Fix the auth bug, and also add tests for the parser';
    expect(decide(goal, { outcome: 'DELEGATE', parallelSelected: true }, 0.9).strategy).toBe('PARALLEL_DELEGATED');
    expect(decide(goal, { outcome: 'DELEGATE', parallelSelected: undefined }, 0.9).strategy).toBe('SERIAL_DELEGATED');
    // Nobody has said how parallel the pieces are: serial, never a guess.
    expect(decide(goal, { outcome: 'DELEGATE', parallelSelected: true }).strategy).toBe('SERIAL_DELEGATED');
  });

  it('stays MANAGED when the node may not spawn, however splittable the goal', () => {
    const noSpawn: Authority = { ...WIDE, spawn_children: false, max_child_count: 0 };
    const decision = decideStrategy({
      preparation: prep('Fix the auth bug, and also add tests for the parser', noSpawn),
      spentUsd: 0, dispatch: DISPATCH, parallelSelected: true, outcome: 'SELF_EXECUTE',
    });
    expect(decision.strategy).toBe('MANAGED');
  });

  it('never buys a classifier for a task a hard gate already settled', () => {
    const classify = vi.fn<StrategyClassifier>();
    const decision = decideStrategy({
      preparation: prep('Fix the typo in README.md'), spentUsd: 0, dispatch: DISPATCH,
      classify, requiresApproval: true, outcome: 'SELF_EXECUTE',
    });
    expect(classify).not.toHaveBeenCalled();
    expect(decision.strategy).toBe('MANAGED');
    expect(decision.receipt.gate).toBe('approval');
  });

  it('carries a historical prior through without letting it decide', () => {
    const prior = {
      strategy: 'MANAGED' as const, expectedSuccess: 0.9, expectedQuality: 0.8,
      expectedCostUsd: 0.2, expectedLatencyMs: 1000, effectiveObservations: 12,
    };
    const decision = decide('Fix the typo in README.md', { prior });
    expect(decision.evidence.historicalPrior).toEqual(prior);
  });
});
