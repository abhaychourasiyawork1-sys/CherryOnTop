import { describe, it, expect, vi } from 'vitest';
import { decideStrategy, deterministicEvidence, sanitizeClassification, type StrategyClassifier } from './strategy-gate.js';
import { prepareDispatch } from './dispatch-preparation.js';
import type { Authority } from '../schemas/node-contract.js';

const WIDE: Authority = { tools: ['read', 'edit'], spawn_children: true, max_child_count: 3, budget_usd: 10 };

function prep(goal: string, authority: Authority = WIDE) {
  return prepareDispatch({ goal, authority, toolGrant: { allowedTools: null, readOnly: false } });
}

const DISPATCH = { tokens: 100_000, latencyMs: 120_000, costUsd: 0.5 };

function decide(goal: string, over: Partial<Parameters<typeof decideStrategy>[0]> = {}) {
  return decideStrategy({ preparation: prep(goal), spentUsd: 0, dispatch: DISPATCH, ...over });
}

describe('deterministic gate', () => {
  it('does not invoke the classifier for an obvious one-file edit', () => {
    const classify = vi.fn<StrategyClassifier>();
    const decision = decide('Fix the typo in README.md', { classify });
    expect(decision.strategy).toBe('MANAGED');
    expect(classify).not.toHaveBeenCalled();
    expect(decision.evidence.deterministic).toBe(true);
    expect(decision.evidence.reasonCodes).toContain('single_named_target');
  });

  it('does not invoke the classifier for an obvious delegation candidate', () => {
    const classify = vi.fn<StrategyClassifier>();
    const decision = decide('Fix the auth bug, and also add tests for the parser', { classify, parallelSelected: true });
    expect(classify).not.toHaveBeenCalled();
    expect(decision.evidence.partitionability).toBe('YES');
  });

  it('treats a coherent read-only investigation as one unit of work', () => {
    const evidence = deterministicEvidence(prep('Investigate why the scheduler drops retries'));
    expect(evidence.partitionability).toBe('NO');
    expect(evidence.reasonCodes).toContain('coherent_investigation');
  });

  it('honours an explicit request to fan out over every inference', () => {
    const evidence = deterministicEvidence(prep('Split this across multiple agents: tidy src/a.ts'));
    expect(evidence.partitionability).toBe('YES');
    expect(evidence.reasonCodes).toContain('explicit_split_request');
  });
});

describe('classifier stage', () => {
  const ambiguous = 'Bring the whole service in line with the new error handling approach';

  it('is bought exactly once, and only when partitionability is ambiguous', () => {
    expect(deterministicEvidence(prep(ambiguous)).partitionability).toBe('UNCERTAIN');
    const classify = vi.fn<StrategyClassifier>(() => ({
      partitionability: 'YES', parallelism: 'HIGH', confidence: 0.8,
    }));
    const decision = decide(ambiguous, { classify });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(decision.evidence.deterministic).toBe(false);
    expect(decision.evidence.reasonCodes).toContain('classifier_consulted');
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
    const decision = decide(ambiguous, { classify });
    expect(decision.strategy).toBeDefined();
    expect(decision.evidence.reasonCodes).toContain('deterministic_fallback');
    expect(decision.evidence.reasonCodes.some((c) => c.startsWith('classifier_failed'))).toBe(true);
  });

  it('records a receipt explaining the fallback', () => {
    const decision = decide(ambiguous, { classify: () => { throw new Error('nope'); } });
    expect(decision.receipt.chosen).toBeDefined();
    expect(decision.evidence.reasonCodes.join(',')).toMatch(/deterministic_fallback/);
  });
});

describe('economic stage', () => {
  it('reaches SERIAL_DELEGATED when the work splits but parallelism is not justified', () => {
    const decision = decide('Fix the auth bug, and also add tests for the parser', { parallelSelected: false });
    expect(decision.strategy).toBe('SERIAL_DELEGATED');
    expect(decision.evidence.reasonCodes).toContain('delegate_serial:scheduler_did_not_select_parallel');
  });

  it('reaches PARALLEL_DELEGATED only when the scheduler selected parallel work', () => {
    const goal = 'Fix the auth bug, and also add tests for the parser';
    expect(decide(goal, { parallelSelected: true }).strategy).toBe('PARALLEL_DELEGATED');
    expect(decide(goal, { parallelSelected: undefined }).strategy).toBe('SERIAL_DELEGATED');
  });

  it('stays MANAGED when the node may not spawn, however splittable the goal', () => {
    const noSpawn: Authority = { ...WIDE, spawn_children: false, max_child_count: 0 };
    const decision = decideStrategy({
      preparation: prep('Fix the auth bug, and also add tests for the parser', noSpawn),
      spentUsd: 0, dispatch: DISPATCH, parallelSelected: true,
    });
    expect(decision.strategy).toBe('MANAGED');
  });

  it('never buys a classifier for a task a hard gate already settled', () => {
    const classify = vi.fn<StrategyClassifier>();
    const decision = decideStrategy({
      preparation: prep('Fix the typo in README.md'), spentUsd: 0, dispatch: DISPATCH,
      classify, requiresApproval: true,
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
