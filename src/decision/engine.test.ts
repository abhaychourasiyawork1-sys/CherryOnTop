import { describe, it, expect, afterEach } from 'vitest';
import { authorizeExecution, executionCandidates, delegationEstimate, hardGates } from './engine.js';
import { initialEconomicState } from './state.js';
import { decideExecution, type DelegationPricing } from '../engines/decide-execution.js';
import type { Authority } from '../schemas/node-contract.js';

const authority = (over: Partial<Authority> = {}): Authority => ({
  tools: [], spawn_children: true, max_child_count: 2, budget_usd: 5, ...over,
});


describe('hard gates outrank every score', () => {
  it('waits for a person before anything is spent', () => {
    const decision = hardGates({ authority: authority(), spentUsd: 0, requiresApproval: true })!;
    expect(decision.chosen).toBe('WAIT');
    expect(decision.gate).toBe('approval');
    expect(decision.confidence).toBe(1);
  });

  it('stops a node that has spent its budget', () => {
    const decision = hardGates({ authority: authority({ budget_usd: 1 }), spentUsd: 1.25 })!;
    expect(decision.chosen).toBe('STOP');
    expect(decision.gate).toBe('budget');
  });

  it('does not stop a node nobody costed', () => {
    // Zero means nobody costed this, not out of money.
    expect(hardGates({ authority: authority({ budget_usd: 0 }), spentUsd: 99 })).toBeNull();
  });

});

describe('delegationEstimate', () => {
  it('scales with the children actually planned, not a flat doubling', () => {
    const dispatch = { tokens: 1000, latencyMs: 10_000, costUsd: 0.10 };
    // plan + 2 children + synthesize = 4 dispatches; plan + 4 + synthesize = 6.
    expect(delegationEstimate(dispatch, 2).tokens).toBe(4000);
    expect(delegationEstimate(dispatch, 4).tokens).toBe(6000);
    expect(delegationEstimate(dispatch, 4).costUsd).toBeCloseTo(0.60);
  });

  it('does not sum concurrent children into the wall clock', () => {
    const dispatch = { tokens: 1000, latencyMs: 10_000, costUsd: 0.10 };
    // Four children run at once. plan -> child -> synthesize, whatever k is.
    expect(delegationEstimate(dispatch, 4).latencyMs).toBe(30_000);
    expect(delegationEstimate(dispatch, 2).latencyMs).toBe(30_000);
  });
});

const price = (expectedUsd: number, conservativeUsd = expectedUsd * 1.2) => ({ expectedUsd, conservativeUsd });
const pricing = (solo: number, plan: number, children: number, synth: number): DelegationPricing => ({
  solo: price(solo), plan: price(plan), children: price(children), synth: price(synth), childCount: 2,
});
/** Doing the work whole costs 1.0; planning, the pieces and the synthesis cost .4 when it splits. */
const DEARER_WHOLE = pricing(1, 0.05, 0.3, 0.05);
const CHEAPER_WHOLE = pricing(0.2, 0.1, 0.15, 0.05);

describe('authorizeExecution', () => {
  const authority = { tools: [], spawn_children: true, max_child_count: 4, budget_usd: 10 };
  const P = 0.9;
  const splittable = decideExecution({ goal: 'g', authority, splitProbability: P, pricing: DEARER_WHOLE });
  const state = (over: Record<string, unknown> = {}) => ({
    ...initialEconomicState({ goal: 'g', totalTokenBudget: 600_000 }),
    ...over,
  });
  const authorize = (over = {}, economics = splittable, priced = DEARER_WHOLE) =>
    authorizeExecution({ state: state(over), economics, pricing: priced, splitProbability: P });

  it('delegates when the work comes apart and doing it whole costs more than splitting it', () => {
    const result = authorize();
    expect(splittable.outcome).toBe('DELEGATE');
    expect(result.outcome).toBe('DELEGATE');
    expect(result.decision?.ranked?.[0].id).toBe('execution:delegate');
  });

  it('does not delegate when splitting costs more than it saves', () => {
    // The plan alone costs more than the whole job: however sure the split,
    // the market keeps the work.
    const economics = decideExecution({ goal: 'g', authority, splitProbability: 1, pricing: CHEAPER_WHOLE });
    expect(economics.outcome).toBe('SELF_EXECUTE');
    const result = authorizeExecution({ state: state(), economics, pricing: CHEAPER_WHOLE, splitProbability: 1 });
    expect(result.outcome).toBe('SELF_EXECUTE');
  });

  it('can overrule economics on the conservative cost: a delegate the market is unsure of must save by more than its doubt', () => {
    // Expected saving is real, but the conservative bounds erase it.
    const doubtful: DelegationPricing = {
      solo: { expectedUsd: 1, conservativeUsd: 1.02 }, plan: { expectedUsd: 0.05, conservativeUsd: 0.3 },
      children: { expectedUsd: 0.3, conservativeUsd: 0.6 }, synth: { expectedUsd: 0.05, conservativeUsd: 0.2 }, childCount: 2,
    };
    const economics = decideExecution({ goal: 'g', authority, splitProbability: P, pricing: doubtful });
    expect(economics.outcome).toBe('DELEGATE');
    const result = authorizeExecution({ state: state(), economics, pricing: doubtful, splitProbability: P });
    expect(result.outcome).toBe('SELF_EXECUTE');
    expect(result.decision?.action.id).toBe('execution:self');
  });

  it('vetoes a fan-out on a run that is under a hard stop', () => {
    // Delegation is the most expensive action the runtime has and it was the
    // one that never passed through the common constraints.
    const result = authorize({ constraints: { ...state().constraints, hardStop: true } });
    expect(result.outcome).toBe('SELF_EXECUTE');
    expect(result.gate).toBe('hard_stop');
  });

  it('vetoes a fan-out that cannot be afforded', () => {
    const result = authorize({
      resources: { ...state().resources, consumedTokens: 599_900, remainingTokens: 100 },
    });
    expect(result.outcome).toBe('SELF_EXECUTE');
    expect(result.gate).toBe('insufficient_budget');
  });

  it('will not let a fan-out eat the recovery reserve', () => {
    const result = authorize({
      resources: {
        ...state().resources,
        consumedTokens: 400_000, remainingTokens: 200_000, recoveryReserve: 199_900,
      },
    });
    expect(result.outcome).toBe('SELF_EXECUTE');
    expect(result.gate).toBe('insufficient_budget');
  });

  it('passes authority gates through without inventing a ranking for them', () => {
    // A gate is not a comparison. Presenting one as a decision receipt would
    // claim a comparison nobody made.
    const noSpawn = decideExecution({
      goal: 'g', authority: { ...authority, spawn_children: false }, splitProbability: P, pricing: DEARER_WHOLE,
    });
    const result = authorize({}, noSpawn);
    expect(result.outcome).toBe('SELF_EXECUTE');
    expect(result.gate).toBe('no-spawn-authority');
    expect(result.decision).toBeNull();

    const poor = decideExecution({
      goal: 'g', authority: { ...authority, budget_usd: 0.1 }, splitProbability: P, pricing: DEARER_WHOLE,
    });
    expect(authorize({}, poor).outcome).toBe('ESCALATE');
  });

  it('treats a goal nobody judged to split as an authority gate', () => {
    const single = decideExecution({ goal: 'g', authority, pricing: DEARER_WHOLE });
    const result = authorize({}, single);
    expect(result.outcome).toBe('SELF_EXECUTE');
    expect(result.gate).toBe('single-unit-of-work');
  });
});

describe('executionCandidates', () => {
  const state = initialEconomicState({ goal: 'g', totalTokenBudget: 600_000 });

  it('prices self as the solo run and delegate as the plan plus what a split adds, weighted by how likely it is', () => {
    const { estimates } = executionCandidates({ state, pricing: DEARER_WHOLE, splitProbability: 0.5 });
    expect(estimates['execution:self'].immediateCost.usd).toBeCloseTo(1);
    // plan .05 + 0.5·(children .3 + synth .05) + 0.5·solo 1
    expect(estimates['execution:delegate'].immediateCost.usd).toBeCloseTo(0.05 + 0.5 * 0.35 + 0.5 * 1);
  });

  it('carries the conservative cost of each, so doubt costs the delegate what it costs anything', () => {
    const { estimates } = executionCandidates({ state, pricing: DEARER_WHOLE, splitProbability: 1 });
    expect(estimates['execution:self'].bounds.costUpperBoundUsd).toBeCloseTo(1.2);
    expect(estimates['execution:delegate'].bounds.costUpperBoundUsd).toBeCloseTo(1.2 * (0.05 + 0.3 + 0.05));
  });

  it('is cheaper to delegate the likelier the work is to split', () => {
    const at = (p: number) => executionCandidates({ state, pricing: DEARER_WHOLE, splitProbability: p })
      .estimates['execution:delegate'].immediateCost.usd;
    expect(at(0.9)).toBeLessThan(at(0.4));
  });

  it('prices nothing from the goal or from a table: only the market’s numbers', () => {
    const { candidates } = executionCandidates({ state, pricing: DEARER_WHOLE, splitProbability: 0.5 });
    expect(candidates.map((c) => c.id)).toEqual(['execution:self', 'execution:delegate']);
  });
});
