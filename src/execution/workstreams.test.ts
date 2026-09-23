import { describe, it, expect } from 'vitest';
import {
  planWorkstreams, schedulingCandidates, coordinationCostOf, EMPTY_PLAN,
  type WorkstreamNode,
} from './workstreams.js';
import { initialEconomicState, normalizeEconomicState, type EconomicState } from '../decision/state.js';

const node = (id: string, over: Partial<WorkstreamNode> = {}): WorkstreamNode => ({
  id,
  inputDependencies: [], informationDependencies: [],
  outputDependencies: [], validationDependencies: [], writePaths: [],
  ...over,
});

function state(over: Partial<EconomicState> = {}): EconomicState {
  const base = initialEconomicState({ goal: 'g', totalTokenBudget: 200_000 });
  return normalizeEconomicState({
    ...base,
    trajectory: { ...base.trajectory, orchestrationConfidence: 0.9 },
    resources: { ...base.resources, latencyBudgetMs: 1_200_000 },
    ...over,
  });
}

describe('independent work can run together', () => {
  it('puts branches that share nothing in one group', () => {
    const plan = planWorkstreams({ nodes: [node('a'), node('b'), node('c')] });
    expect(plan.parallelGroups).toEqual([['a', 'b', 'c']]);
    expect(plan.serializationReasons).toEqual([]);
  });

  it('plans nothing for no work', () => {
    expect(planWorkstreams({ nodes: [] })).toEqual(EMPTY_PLAN);
  });

  it('is deterministic whatever order the caller built the set in', () => {
    const nodes = [node('c'), node('a'), node('b')];
    expect(planWorkstreams({ nodes })).toEqual(planWorkstreams({ nodes: [...nodes].reverse() }));
  });
});

describe('needing the same knowledge is not an ordering constraint', () => {
  it('lets two branches that must understand the same module run at once', () => {
    const plan = planWorkstreams({
      nodes: [
        node('a', { informationDependencies: ['src/auth/session.ts'] }),
        node('b', { informationDependencies: ['src/auth/session.ts'] }),
      ],
    });
    // Collapsing information into ordering is how a scheduler serializes most
    // of the branches on any real goal.
    expect(plan.parallelGroups).toEqual([['a', 'b']]);
  });

  it('names what more than one branch needs', () => {
    const plan = planWorkstreams({
      nodes: [
        node('a', { informationDependencies: ['shared.ts', 'only-a.ts'] }),
        node('b', { informationDependencies: ['shared.ts'] }),
      ],
    });
    expect(plan.sharedEvidenceIds).toEqual(['shared.ts']);
  });

  it('prices what letting each branch find it itself would cost', () => {
    const plan = planWorkstreams({
      nodes: [
        node('a', { informationDependencies: ['shared.ts'] }),
        node('b', { informationDependencies: ['shared.ts'] }),
        node('c', { informationDependencies: ['shared.ts'] }),
      ],
      evidenceTokenCost: () => 1_000,
    });
    // Three branches, one piece of knowledge: two acquisitions are redundant.
    expect(plan.informationDuplication).toBe(2_000);
  });

  it('reports no duplication when nothing is shared', () => {
    const plan = planWorkstreams({
      nodes: [node('a', { informationDependencies: ['a.ts'] }), node('b', { informationDependencies: ['b.ts'] })],
      evidenceTokenCost: () => 1_000,
    });
    expect(plan.sharedEvidenceIds).toEqual([]);
    expect(plan.informationDuplication).toBe(0);
  });
});

describe('write conflicts and output dependencies do order work', () => {
  it('never lets two branches write the same path at once', () => {
    const plan = planWorkstreams({
      nodes: [
        node('a', { writePaths: ['src/cart/checkout.ts'] }),
        node('b', { writePaths: ['src/cart/checkout.ts'] }),
      ],
    });
    // Not a cost. Two branches writing one file produce a tree neither expected,
    // and no latency saving is worth that.
    expect(plan.parallelGroups).toEqual([['a'], ['b']]);
    expect(plan.serializationReasons.some((r) => r.startsWith('write_conflict:'))).toBe(true);
  });

  it('lets two branches write different paths at once', () => {
    const plan = planWorkstreams({
      nodes: [node('a', { writePaths: ['src/a.ts'] }), node('b', { writePaths: ['src/b.ts'] })],
    });
    expect(plan.parallelGroups).toEqual([['a', 'b']]);
  });

  it('orders a branch after the one whose output it consumes', () => {
    const plan = planWorkstreams({
      nodes: [node('producer'), node('consumer', { inputDependencies: ['producer'] })],
    });
    expect(plan.parallelGroups).toEqual([['producer'], ['consumer']]);
    expect(plan.serializationReasons).toContain('ordered_after:consumer<-producer');
  });

  it('orders a branch after the one it must be validated against', () => {
    const plan = planWorkstreams({
      nodes: [node('impl'), node('check', { validationDependencies: ['impl'] })],
    });
    expect(plan.parallelGroups).toEqual([['impl'], ['check']]);
  });

  it('respects an ordering stated from the producing side', () => {
    const plan = planWorkstreams({
      nodes: [node('producer', { outputDependencies: ['consumer'] }), node('consumer')],
    });
    expect(plan.parallelGroups[0]).not.toContain('consumer');
  });

  it('ignores a dependency on work that is not in the plan', () => {
    const plan = planWorkstreams({ nodes: [node('a', { inputDependencies: ['not-here'] })] });
    expect(plan.parallelGroups).toEqual([['a']]);
  });

  it('degrades a dependency cycle to serial rather than refusing to plan', () => {
    // A graph this module did not build must not be able to take down a
    // dispatch. Serial is not correct, but it is safe.
    const plan = planWorkstreams({
      nodes: [
        node('a', { inputDependencies: ['b'] }),
        node('b', { inputDependencies: ['a'] }),
      ],
    });
    expect(plan.parallelGroups).toEqual([['a'], ['b']]);
    expect(plan.serializationReasons.some((r) => r.startsWith('dependency_cycle:'))).toBe(true);
  });

  it('handles a mix of ordering and conflict across several rounds', () => {
    const plan = planWorkstreams({
      nodes: [
        node('a', { writePaths: ['x.ts'] }),
        node('b', { writePaths: ['x.ts'] }),
        node('c', { inputDependencies: ['a'] }),
        node('d'),
      ],
    });
    expect(plan.parallelGroups.flat().sort()).toEqual(['a', 'b', 'c', 'd']);
    // Everything is scheduled exactly once.
    expect(new Set(plan.parallelGroups.flat()).size).toBe(4);
  });
});

describe('parallelism is a candidate, never a rule', () => {
  const branches = (count: number, shared: string[] = []) =>
    Array.from({ length: count }, (_, i) => node(`b${i}`, { informationDependencies: shared }));

  const candidates = (nodes: WorkstreamNode[], over: Partial<Parameters<typeof schedulingCandidates>[0]> = {}) =>
    schedulingCandidates({
      plan: planWorkstreams({ nodes, evidenceTokenCost: () => 2_000 }),
      state: state(), contextTokensPerBranch: 4_000, branchLatencyMs: 120_000, ...over,
    });

  it('offers running together and running in order as a pair', () => {
    const kinds = candidates(branches(3)).map((c) => c.kind);
    // A scheduler that only ever proposes the fast option has not made a
    // decision.
    expect(kinds).toContain('parallelize');
    expect(kinds).toContain('serialize');
  });

  it('offers nothing for a group that cannot be parallel anyway', () => {
    expect(candidates([node('only')])).toEqual([]);
  });

  it('charges every extra branch for its own context', () => {
    const two = candidates(branches(2)).find((c) => c.kind === 'parallelize')!;
    const four = candidates(branches(4)).find((c) => c.kind === 'parallelize')!;
    expect(four.coordinationCost).toBeGreaterThan(two.coordinationCost);
  });

  it('lets serializing win when coordination outweighs the wall-clock', () => {
    // The measured case: branches that all read the same repository, where a
    // fan-out costs N times one dispatch and answers a fraction of the question
    // each.
    const expensive = candidates(branches(4), { contextTokensPerBranch: 60_000, branchLatencyMs: 1_000 });
    const parallel = expensive.find((c) => c.kind === 'parallelize')!;
    const serial = expensive.find((c) => c.kind === 'serialize')!;
    expect(serial.expectedTokenBenefit).toBeGreaterThan(parallel.expectedTokenBenefit);
    expect(parallel.coordinationCost).toBeGreaterThan(0);
  });

  it('lets parallelizing win when the branches are genuinely independent and slow', () => {
    const worthwhile = candidates(branches(3), { contextTokensPerBranch: 200, branchLatencyMs: 400_000 });
    const parallel = worthwhile.find((c) => c.kind === 'parallelize')!;
    expect(parallel.expectedLatencyBenefit).toBeGreaterThan(0);
    expect(parallel.coordinationCost).toBeLessThan(1_000);
  });

  it('claims the saving from acquiring shared knowledge once', () => {
    const shared = candidates(branches(3, ['src/auth/session.ts'])).find((c) => c.kind === 'parallelize')!;
    const unshared = candidates(branches(3)).find((c) => c.kind === 'parallelize')!;
    expect(shared.expectedTokenBenefit).toBeGreaterThan(unshared.expectedTokenBenefit);
  });

  it('prices the risk that more branches means more ways to go wrong', () => {
    const two = candidates(branches(2)).find((c) => c.kind === 'parallelize')!;
    const five = candidates(branches(5)).find((c) => c.kind === 'parallelize')!;
    expect(five.failureRisk).toBeGreaterThan(two.failureRisk);
  });

  it('carries the group it is about, for whoever acts on it', () => {
    const parallel = candidates(branches(2)).find((c) => c.kind === 'parallelize')!;
    expect(parallel.metadata.group).toEqual(['b0', 'b1']);
  });
});

describe('coordinationCostOf', () => {
  it('charges nothing for a single branch', () => {
    const plan = planWorkstreams({ nodes: [node('a')] });
    expect(coordinationCostOf(plan, ['a'], 4_000)).toBe(0);
  });

  it('never returns a negative cost', () => {
    const plan = planWorkstreams({ nodes: [node('a'), node('b')] });
    expect(coordinationCostOf(plan, ['a', 'b'], -5_000)).toBeGreaterThanOrEqual(0);
  });
});
