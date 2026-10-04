import { describe, it, expect } from 'vitest';
import { decideExecution, economicsInputFor, requiredBudgetUsd, type DelegationPricing } from './decide-execution.js';
import { decompositionBoundary } from '../system1/economic-mapping.js';
import type { Authority } from '../schemas/node-contract.js';

const price = (expectedUsd: number, conservativeUsd = expectedUsd * 1.2) => ({ expectedUsd, conservativeUsd });
const pricing = (solo: number, plan: number, children: number, synth: number): DelegationPricing => ({
  solo: price(solo), plan: price(plan), children: price(children), synth: price(synth), childCount: 2,
});
// Doing the work whole costs 1; splitting it costs .05 + .3 + .05 when it splits.
const DEARER_WHOLE = pricing(1, 0.05, 0.3, 0.05);
const CHEAPER_WHOLE = pricing(0.2, 0.1, 0.15, 0.05);

const cannotSpawn: Authority = { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 5 };
const canSpawnRichBudget: Authority = { tools: [], spawn_children: true, max_child_count: 3, budget_usd: 10 };
const canSpawnPoorBudget: Authority = { tools: [], spawn_children: true, max_child_count: 3, budget_usd: 0.01 };

describe('decideExecution', () => {
  it('self-executes unconditionally when the node cannot spawn children', () => {
    const result = decideExecution({ goal: 'g', authority: cannotSpawn, splitProbability: 1, pricing: DEARER_WHOLE });
    expect(result.outcome).toBe('SELF_EXECUTE');
  });

  it('does not pay to find out about a split nobody judged to exist', () => {
    const result = decideExecution({ goal: 'g', authority: canSpawnRichBudget, pricing: DEARER_WHOLE });
    expect(result.outcome).toBe('SELF_EXECUTE');
    expect(result.breakdown.reason_single_unit_of_work).toBe(1);
  });

  it('does not delegate what it cannot price', () => {
    const result = decideExecution({ goal: 'g', authority: canSpawnRichBudget, splitProbability: 1 });
    expect(result.outcome).toBe('SELF_EXECUTE');
  });

  it('escalates when spawning is allowed and worth it but the authority cannot fund plan, pieces and synthesis', () => {
    const result = decideExecution({ goal: 'g', authority: canSpawnPoorBudget, splitProbability: 0.9, pricing: DEARER_WHOLE });
    expect(result.outcome).toBe('ESCALATE');
    expect(result.breakdown.availableBudget).toBe(0.01);
    expect(result.breakdown.requiredBudget).toBeCloseTo(requiredBudgetUsd(DEARER_WHOLE));
    expect(requiredBudgetUsd(DEARER_WHOLE)).toBeGreaterThan(canSpawnPoorBudget.budget_usd);
  });

  it('delegates when the work comes apart and doing it whole costs more than splitting it', () => {
    const result = decideExecution({ goal: 'g', authority: canSpawnRichBudget, splitProbability: 0.9, pricing: DEARER_WHOLE });
    expect(result.outcome).toBe('DELEGATE');
    expect(result.breakdown.score).toBeGreaterThan(0);
  });

  it('self-executes cheap work even when it certainly splits', () => {
    const result = decideExecution({ goal: 'g', authority: canSpawnRichBudget, splitProbability: 1, pricing: CHEAPER_WHOLE });
    expect(result.outcome).toBe('SELF_EXECUTE');
  });

  it('turns on the probability at which the market says trying beats not trying', () => {
    const boundary = decompositionBoundary(DEARER_WHOLE)!;
    const at = (p: number) => decideExecution({ goal: 'g', authority: canSpawnRichBudget, splitProbability: p, pricing: DEARER_WHOLE }).outcome;
    expect(at(boundary.threshold + 0.02)).toBe('DELEGATE');
    expect(at(boundary.threshold - 0.02)).toBe('SELF_EXECUTE');
  });

  it('prices delegation as solo cost saved less everything spent finding out and splitting', () => {
    const input = economicsInputFor(DEARER_WHOLE, 0.5);
    expect(input.estimatedValue).toBeCloseTo(0.5 * 1);
    expect(input.modelCost).toBeCloseTo(0.05 + 0.5 * (0.3 + 0.05));
    expect(input.threshold).toBe(0);
  });

  it('always returns a printable breakdown, even for the cannot-spawn short-circuit', () => {
    const result = decideExecution({ goal: 'x', authority: cannotSpawn });
    expect(typeof result.breakdown.score).toBe('number');
  });
});
