import { describe, it, expect } from 'vitest';
import { allocateBudget, allocationTotal, EMPTY_ALLOCATION } from './budget.js';
import { actionCandidate, type ActionCandidate, type ActionKind } from './actions.js';
import { initialEconomicState, normalizeEconomicState, type EconomicState } from './state.js';

function state(over: Partial<EconomicState> = {}): EconomicState {
  const base = initialEconomicState({ goal: 'g', totalTokenBudget: 100_000, qualityFloor: 0.7 });
  return normalizeEconomicState({
    ...base, ...over,
    resources: { ...base.resources, latencyBudgetMs: 600_000, ...over.resources },
  });
}

const of = (id: string, kind: ActionKind, over: Partial<ActionCandidate> = {}) =>
  actionCandidate({ id, kind, capability: `cap.${kind}`, confidence: 1, ...over });

describe('allocation follows opportunity, not a table', () => {
  it('gives two states with different opportunities different allocations', () => {
    const exploring = allocateBudget({
      state: state(),
      opportunities: [of('e', 'explore', { expectedTokenBenefit: 40_000, tokenCost: 8_000 })],
    });
    const validating = allocateBudget({
      state: state(),
      opportunities: [of('v', 'validate', { expectedQualityBenefit: 0.5, tokenCost: 8_000 })],
    });

    expect(exploring.exploration).toBeGreaterThan(0);
    expect(exploring.validation).toBe(0);
    expect(validating.validation).toBeGreaterThan(0);
    expect(validating.exploration).toBe(0);
  });

  it('gives the same task label different allocations as its opportunities change', () => {
    // The task has not changed. Only what there is to do about it has.
    const s = state();
    const early = allocateBudget({
      state: s,
      opportunities: [of('ctx', 'acquire_evidence', { capability: 'context.select', expectedTokenBenefit: 30_000, tokenCost: 4_000 })],
    });
    const later = allocateBudget({
      state: s,
      opportunities: [of('val', 'validate', { expectedQualityBenefit: 0.6, tokenCost: 4_000 })],
    });
    expect(early).not.toEqual(later);
    expect(early.context).toBeGreaterThan(0);
    expect(later.context).toBe(0);
  });

  it('allocates more to the more valuable of two competing opportunities', () => {
    const allocation = allocateBudget({
      state: state(),
      opportunities: [
        of('big', 'explore', { expectedTokenBenefit: 80_000, tokenCost: 20_000 }),
        of('small', 'validate', { expectedQualityBenefit: 0.05, tokenCost: 20_000 }),
      ],
    });
    expect(allocation.exploration).toBeGreaterThan(allocation.validation);
  });

  it('budgets context and other evidence apart', () => {
    const allocation = allocateBudget({
      state: state(),
      opportunities: [
        of('ctx', 'acquire_evidence', { capability: 'context.select', expectedTokenBenefit: 30_000, tokenCost: 5_000 }),
        of('file', 'acquire_evidence', { capability: 'evidence.read-file', expectedTokenBenefit: 30_000, tokenCost: 5_000 }),
      ],
    });
    expect(allocation.context).toBeGreaterThan(0);
    expect(allocation.evidence).toBeGreaterThan(0);
  });
});

describe('nothing is held back for work nobody proposed', () => {
  it('allocates nothing when there are no opportunities', () => {
    const allocation = allocateBudget({ state: state(), opportunities: [] });
    expect(allocation.unallocated).toBe(100_000);
    expect({ ...allocation, unallocated: 0 }).toEqual(EMPTY_ALLOCATION);
  });

  it('caps a bucket at what its opportunities actually asked for', () => {
    const allocation = allocateBudget({
      state: state(),
      opportunities: [of('cheap', 'validate', { expectedQualityBenefit: 0.9, tokenCost: 300 })],
    });
    expect(allocation.validation).toBeLessThanOrEqual(300);
    expect(allocation.unallocated).toBeGreaterThan(90_000);
  });

  it('funds nothing against an opportunity a hard constraint forbids', () => {
    const allocation = allocateBudget({
      state: state(),
      opportunities: [of('unsafe', 'explore', {
        expectedTokenBenefit: 90_000, tokenCost: 10_000, metadata: { unsafe: true },
      })],
    });
    expect(allocation.exploration).toBe(0);
  });

  it('funds nothing against an opportunity that is not worth taking', () => {
    const allocation = allocateBudget({
      state: state(),
      opportunities: [of('lossy', 'explore', { expectedTokenBenefit: 10, tokenCost: 20_000 })],
    });
    expect(allocation.exploration).toBe(0);
  });

  it('allocates nothing at all once the budget is gone', () => {
    const spent = state({ resources: { ...state().resources, consumedTokens: 100_000 } });
    expect(allocateBudget({
      state: spent,
      opportunities: [of('e', 'explore', { expectedTokenBenefit: 5_000 })],
    })).toEqual(EMPTY_ALLOCATION);
  });
});

describe('the recovery reserve appears and disappears with the reason for it', () => {
  const failing = () => state({
    trajectory: { ...state().trajectory, failurePressure: 0.9, progress: 0.1 },
  });

  it('holds capacity back while a retry is worth making', () => {
    const allocation = allocateBudget({
      state: failing(),
      opportunities: [of('r', 'recover', {
        expectedProgress: 0.8, expectedTokenBenefit: 50_000, tokenCost: 15_000, failureRisk: 0.2,
      })],
    });
    expect(allocation.recoveryReserve).toBeGreaterThan(0);
  });

  it('releases it when the opportunity is gone, without anything having to remember to', () => {
    const recovered = allocateBudget({
      state: state(),
      opportunities: [of('e', 'explore', { expectedTokenBenefit: 40_000, tokenCost: 5_000 })],
    });
    expect(recovered.recoveryReserve).toBe(0);
  });

  it('holds back less for a retry that is unlikely to work', () => {
    // Scarcity is what makes the comparison visible: with room for everything,
    // both allocations stop at what they asked for and the difference in how
    // likely each is to work never gets to matter. Here the two opportunities
    // together want more than is left, so the split is by value.
    const scarce = () => state({
      resources: { ...state().resources, consumedTokens: 90_000 },
      trajectory: { ...state().trajectory, failurePressure: 0.9, progress: 0.1 },
    });
    const competing = (failureRisk: number) => [
      of('r', 'recover', { expectedProgress: 0.8, expectedTokenBenefit: 50_000, tokenCost: 6_000, failureRisk }),
      of('e', 'explore', { expectedTokenBenefit: 40_000, tokenCost: 6_000 }),
    ];
    const likely = allocateBudget({ state: scarce(), opportunities: competing(0.1) });
    const unlikely = allocateBudget({ state: scarce(), opportunities: competing(0.9) });
    expect(unlikely.recoveryReserve).toBeLessThan(likely.recoveryReserve);
  });
});

describe('orchestration is accounted, and charged to the optimizer', () => {
  it('takes declared overhead off the top', () => {
    const allocation = allocateBudget({
      state: state(),
      opportunities: [of('e', 'explore', {
        expectedTokenBenefit: 40_000, tokenCost: 5_000, orchestrationCost: 250,
      })],
    });
    expect(allocation.orchestration).toBe(250);
  });

  it('never charges more orchestration than the optimizer has left', () => {
    const nearlySpent = state({
      resources: { ...state().resources, optimizationTokens: 1_000, optimizationConsumedTokens: 900 },
    });
    const allocation = allocateBudget({
      state: nearlySpent,
      opportunities: [of('e', 'explore', {
        expectedTokenBenefit: 40_000, tokenCost: 5_000, orchestrationCost: 50_000,
      })],
    });
    expect(allocation.orchestration).toBe(100);
  });

  it('charges nothing when no opportunity declares overhead', () => {
    expect(allocateBudget({
      state: state(),
      opportunities: [of('e', 'explore', { expectedTokenBenefit: 40_000, tokenCost: 5_000 })],
    }).orchestration).toBe(0);
  });
});

describe('the books balance', () => {
  const sets: ActionCandidate[][] = [
    [],
    [of('e', 'explore', { expectedTokenBenefit: 40_000, tokenCost: 5_000 })],
    [
      of('ctx', 'acquire_evidence', { capability: 'context.select', expectedTokenBenefit: 30_000, tokenCost: 90_000 }),
      of('v', 'validate', { expectedQualityBenefit: 0.5, tokenCost: 90_000 }),
      of('r', 'recover', { expectedTokenBenefit: 60_000, tokenCost: 90_000, orchestrationCost: 400 }),
    ],
    [of('c', 'continue'), of('s', 'stop'), of('p', 'parallelize', { expectedLatencyBenefit: 300_000 })],
  ];

  it('accounts for every remaining token, in every case', () => {
    for (const opportunities of sets) {
      const allocation = allocateBudget({ state: state(), opportunities });
      expect(allocationTotal(allocation)).toBeCloseTo(100_000, 6);
    }
  });

  it('never allocates a negative amount', () => {
    for (const opportunities of sets) {
      const allocation = allocateBudget({ state: state(), opportunities });
      for (const value of Object.values(allocation)) expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it('shares out what the caps freed rather than stranding it', () => {
    // One bucket wants far more than its proportional share; another wants
    // almost nothing. The surplus the cheap bucket could not use goes to the
    // one that wanted it.
    const allocation = allocateBudget({
      state: state(),
      opportunities: [
        of('hungry', 'explore', { expectedTokenBenefit: 90_000, tokenCost: 80_000 }),
        of('tiny', 'validate', { expectedQualityBenefit: 0.5, tokenCost: 100 }),
      ],
    });
    expect(allocation.validation).toBeLessThanOrEqual(100);
    expect(allocation.exploration).toBeGreaterThan(50_000);
  });

  it('is deterministic', () => {
    const opportunities = sets[2];
    expect(allocateBudget({ state: state(), opportunities }))
      .toEqual(allocateBudget({ state: state(), opportunities }));
  });
});
