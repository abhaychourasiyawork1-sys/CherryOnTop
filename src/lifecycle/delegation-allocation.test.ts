/** Delegation and parallelism are two decisions, and this file is where they
 *  stay apart.
 *
 *  A fan-out that treats every delegation as parallel spends coordination it
 *  never priced; one that treats "cannot parallelize" as "cannot delegate"
 *  throws away the capability entirely. Both are cheap mistakes to make in the
 *  same function, which is why the topology choice and the budget split are
 *  separate and both deterministic. */
import { describe, it, expect } from 'vitest';
import { allocateChildAuthority, delegationTopology, childAuthority, workstreamNodesFor } from './delegate-child.js';
import { planWorkstreams, schedulingCandidates } from '../execution/workstreams.js';
import { delegationEstimate } from '../decision/engine.js';
import { novelState } from '../architecture/fixtures.js';
import type { Authority } from '../schemas/node-contract.js';

const PARENT: Authority = {
  tools: ['Read', 'Edit'], spawn_children: true, max_child_count: 3, budget_usd: 5,
};

describe('allocateChildAuthority', () => {
  it('never allocates children beyond the parent budget envelope', () => {
    const allocation = allocateChildAuthority({ parent: PARENT, childCount: 3, reserveBudgetUsd: 1 });
    expect(allocation.totalAllocatedUsd).toBeLessThanOrEqual(4);
    expect(allocation.childBudgetsUsd).toHaveLength(3);
    expect(allocation.remainingParentBudgetUsd).toBeCloseTo(1);
  });

  it('keeps the reserve even when the reserve is larger than the budget', () => {
    const allocation = allocateChildAuthority({ parent: PARENT, childCount: 2, reserveBudgetUsd: 99 });
    expect(allocation.totalAllocatedUsd).toBe(0);
    expect(allocation.childBudgetsUsd).toEqual([0, 0]);
  });

  it('allocates nothing when there are no children', () => {
    const allocation = allocateChildAuthority({ parent: PARENT, childCount: 0, reserveBudgetUsd: 1 });
    expect(allocation.childBudgetsUsd).toEqual([]);
    expect(allocation.remainingParentBudgetUsd).toBe(5);
  });

  it('agrees with childAuthority when the reserve is the parent\'s own share', () => {
    // childAuthority's default: one share of k+1 kept for planning and synthesis.
    const k = 3;
    const share = PARENT.budget_usd / (k + 1);
    const allocation = allocateChildAuthority({ parent: PARENT, childCount: k, reserveBudgetUsd: share });
    expect(allocation.childBudgetsUsd[0]).toBeCloseTo(childAuthority(PARENT, k).budget_usd);
  });

  it('never grants a child spawn authority it could not afford to use', () => {
    const poor: Authority = { ...PARENT, budget_usd: 1.2 };
    expect(childAuthority(poor, 2).spawn_children).toBe(false);
  });
});

describe('delegationTopology', () => {
  const independent = planWorkstreams({
    nodes: workstreamNodesFor(['add tests to src/a.ts', 'document src/b.ts']),
  });
  const dependent = planWorkstreams({
    nodes: [
      { id: '0', inputDependencies: [], informationDependencies: [], outputDependencies: [], validationDependencies: [], writePaths: ['src/a.ts'] },
      { id: '1', inputDependencies: ['0'], informationDependencies: [], outputDependencies: [], validationDependencies: [], writePaths: ['src/b.ts'] },
    ],
  });

  it('is serial when ordering requires it, however keen the economics', () => {
    expect(delegationTopology(dependent, ['parallelize'])).toBe('SERIAL_DELEGATED');
  });

  it('is serial when the graph allows concurrency but the economics did not choose it', () => {
    expect(independent.parallelGroups.some((group) => group.length > 1)).toBe(true);
    expect(delegationTopology(independent, ['serialize'])).toBe('SERIAL_DELEGATED');
  });

  it('is parallel only when the graph allows it and the economics chose it', () => {
    expect(delegationTopology(independent, ['parallelize'])).toBe('PARALLEL_DELEGATED');
  });

  it('treats "cannot parallelize" as a scheduling result, not as "cannot delegate"', () => {
    expect(delegationTopology(dependent, [])).toBe('SERIAL_DELEGATED');
  });

  it('offers both alternatives to the economics for every concurrent group', () => {
    const kinds = schedulingCandidates({
      plan: independent, state: novelState(), contextTokensPerBranch: 4_000, branchLatencyMs: 120_000,
    }).map((candidate) => candidate.kind);
    expect(kinds).toContain('parallelize');
    expect(kinds).toContain('serialize');
  });

  it('forces serialization when two branches would write the same file', () => {
    const conflicting = planWorkstreams({
      nodes: workstreamNodesFor(['rewrite src/a.ts entry point', 'extract helpers from src/a.ts']),
    });
    expect(conflicting.parallelGroups.every((group) => group.length === 1)).toBe(true);
    expect(conflicting.serializationReasons.some((r) => r.startsWith('write_conflict'))).toBe(true);
    expect(delegationTopology(conflicting, ['parallelize'])).toBe('SERIAL_DELEGATED');
  });
});

describe('what a fan-out is estimated to cost', () => {
  const dispatch = { tokens: 100_000, latencyMs: 120_000, costUsd: 0.5 };

  it('charges plan + children + synthesis for tokens and money', () => {
    const three = delegationEstimate(dispatch, 3);
    expect(three.tokens).toBe(dispatch.tokens * 5);
    expect(three.costUsd).toBeCloseTo(dispatch.costUsd * 5);
  });

  it('charges plan + one child + synthesis for wall time, because children overlap', () => {
    expect(delegationEstimate(dispatch, 3).latencyMs).toBe(dispatch.latencyMs * 3);
    expect(delegationEstimate(dispatch, 5).latencyMs).toBe(delegationEstimate(dispatch, 3).latencyMs);
  });

  it('scales with the real child count rather than a flat multiple', () => {
    expect(delegationEstimate(dispatch, 4).costUsd).toBeGreaterThan(delegationEstimate(dispatch, 2).costUsd);
  });
});
