import { describe, it, expect, afterEach } from 'vitest';
import { authorizeExecution, executionCandidates, delegationEstimate, hardGates } from './engine.js';
import { initialEconomicState } from './state.js';
import { decideExecution } from '../engines/decide-execution.js';
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

describe('authorizeExecution', () => {
  const authority = { tools: [], spawn_children: true, max_child_count: 4, budget_usd: 10 };
  const splittable = decideExecution({ goal: 'g', authority, complexity: 'high', worthSplitting: true });
  const dispatch = { tokens: 100_000, latencyMs: 120_000, costUsd: 0 };
  const state = (over: Record<string, unknown> = {}) => ({
    ...initialEconomicState({ goal: 'g', totalTokenBudget: 600_000 }),
    ...over,
  });
  const authorize = (over = {}, economics = splittable) =>
    authorizeExecution({ state: state(over), economics, dispatch, plannedChildCount: 4 });

  it('delegates when the estimator’s margin pays for what splitting adds', () => {
    // The market decides now, on cost-to-go: the fan-out's planning and
    // synthesis dispatches against the rework its margin is expected to save.
    const result = authorize();
    expect(result.outcome).toBe('DELEGATE');
    expect(result.decision?.ranked?.[0].id).toBe('execution:delegate');
    // Self is not merely outranked but beaten on every axis.
    expect(result.decision?.pruned).toContain('execution:self');
  });

  it('does not delegate when splitting adds more than it saves', () => {
    // Coordination priced at two whole execute dispatches outweighs the same
    // margin: the market keeps the work, where the old threshold would split.
    const result = authorizeExecution({
      state: state(), economics: splittable, dispatch, plannedChildCount: 4,
      coordinationTokens: dispatch.tokens * 2,
    });
    expect(splittable.outcome).toBe('DELEGATE');
    expect(result.outcome).toBe('SELF_EXECUTE');
    expect(result.decision?.action.id).toBe('execution:self');
  });

  it('vetoes a fan-out on a run that is under a hard stop', () => {
    // The gap this whole refactor exists to close. Delegation is the most
    // expensive action the runtime has and it was the one that never passed
    // through the common constraints.
    const result = authorize({ constraints: { ...state().constraints, hardStop: true } });
    expect(result.outcome).toBe('SELF_EXECUTE');
    expect(result.gate).toBe('hard_stop');
  });

  it('vetoes a fan-out that cannot be afforded', () => {
    const result = authorize({
      resources: { ...state().resources, consumedTokens: 590_000, remainingTokens: 10_000 },
    });
    expect(result.outcome).toBe('SELF_EXECUTE');
    expect(result.gate).toBe('insufficient_budget');
  });

  it('will not let a fan-out eat the recovery reserve', () => {
    const result = authorize({
      resources: {
        ...state().resources,
        consumedTokens: 400_000, remainingTokens: 200_000, recoveryReserve: 190_000,
      },
    });
    expect(result.outcome).toBe('SELF_EXECUTE');
    expect(result.gate).toBe('insufficient_budget');
  });

  it('passes authority gates through without inventing a ranking for them', () => {
    // A gate is not a comparison. Presenting one as a decision receipt would
    // claim a comparison nobody made.
    const noSpawn = decideExecution({
      goal: 'g', authority: { ...authority, spawn_children: false },
      complexity: 'high', worthSplitting: true,
    });
    const result = authorize({}, noSpawn);
    expect(result.outcome).toBe('SELF_EXECUTE');
    expect(result.gate).toBe('no-spawn-authority');
    expect(result.decision).toBeNull();

    const poor = decideExecution({
      goal: 'g', authority: { ...authority, budget_usd: 0.4 },
      complexity: 'high', worthSplitting: true,
    });
    expect(authorize({}, poor).outcome).toBe('ESCALATE');
  });

  it('treats a goal that is one unit of work as an authority gate', () => {
    const single = decideExecution({ goal: 'g', authority, complexity: 'low', worthSplitting: false });
    const result = authorize({}, single);
    expect(result.outcome).toBe('SELF_EXECUTE');
    expect(result.gate).toBe('single-unit-of-work');
  });

  it('never delegates on a margin the estimator itself rejected', () => {
    // A zero margin buys nothing, so the fan-out only adds cost: dominated.
    const narrow = decideExecution({ goal: 'g', authority, complexity: 'low', worthSplitting: true });
    expect(authorize({}, narrow).outcome).toBe('SELF_EXECUTE');
  });
});

describe('executionCandidates', () => {
  const authority = { tools: [], spawn_children: true, max_child_count: 4, budget_usd: 10 };
  const economics = decideExecution({ goal: 'g', authority, complexity: 'high', worthSplitting: true });
  const dispatch = { tokens: 100_000, latencyMs: 120_000, costUsd: 0 };

  it('prices the split at the margin, not at the whole task', () => {
    // Absolute pricing makes both options look like they consume the budget,
    // which rejects the expensive one on affordability and drives the cheap one
    // negative — so the comparison never happens at all.
    const [self, delegate] = executionCandidates({ economics, dispatch, plannedChildCount: 4, coordinationTokens: 12_000 });
    expect(self.tokenCost + self.coordinationCost).toBe(0);
    // The planning and synthesis dispatches, which only a fan-out pays for.
    expect(delegate.coordinationCost).toBe(12_000);
    // Absent a measurement, two narrow dispatches — not two execute ones.
    const [, unmeasured] = executionCandidates({ economics, dispatch, plannedChildCount: 4 });
    expect(unmeasured.coordinationCost).toBeLessThan(dispatch.tokens);
  });

  it('charges the two extra dispatches once, not twice', () => {
    // `utility.ts` sums tokenCost and coordinationCost. Setting both would
    // silently double the price of every fan-out.
    const [, delegate] = executionCandidates({ economics, dispatch, plannedChildCount: 4 });
    expect(delegate.tokenCost).toBe(0);
  });

  it('carries the estimator’s net value as the risk one agent fails the whole goal', () => {
    const [self] = executionCandidates({ economics, dispatch, plannedChildCount: 4 });
    expect(self.failureRisk).toBeCloseTo(economics.breakdown.score ?? 0);
  });

  it('lets history about this task shape override the estimator as evidence accumulates', () => {
    const [thin] = executionCandidates({ economics, dispatch, plannedChildCount: 4, history: { direct: { success: 1, observations: 1 } } });
    const [thick] = executionCandidates({ economics, dispatch, plannedChildCount: 4, history: { direct: { success: 1, observations: 200 } } });
    // Direct execution of this shape has always worked: the risk the fan-out
    // was meant to avoid shrinks towards nothing as the evidence grows.
    expect(thick.failureRisk).toBeLessThan(thin.failureRisk);
    expect(thick.failureRisk).toBeLessThan(0.05);
    const [, delegate] = executionCandidates({ economics, dispatch, plannedChildCount: 4, history: { delegated: { success: 0.2, observations: 50 } } });
    expect(delegate.failureRisk).toBeGreaterThan(0.5);
  });

  it('delegates a medium-complexity goal that genuinely splits, as the delegation economics say', () => {
    const medium = decideExecution({ goal: 'g', authority, complexity: 'medium', worthSplitting: true });
    const result = authorizeExecution({
      state: initialEconomicState({ goal: 'g', totalTokenBudget: 600_000 }),
      economics: medium, dispatch, plannedChildCount: 4, coordinationTokens: 10_000,
    });
    expect(medium.outcome).toBe('DELEGATE');
    expect(result.outcome).toBe('DELEGATE');
  });

  it('does not charge the estimator’s risk penalty twice', () => {
    // `score` already has riskPenalty subtracted; the candidate must not
    // subtract it again as quality or failure risk.
    const [, delegate] = executionCandidates({ economics, dispatch, plannedChildCount: 4 });
    expect(economics.breakdown.riskPenalty).toBeGreaterThan(0);
    expect(delegate.qualityRisk).toBe(0);
    expect(delegate.failureRisk).toBe(0);
  });
});
