import { describe, it, expect } from 'vitest';
import { normalizeContextPolicy, normalizeExecutionPolicy, DEFAULT_CONTEXT_POLICY, DEFAULT_EXECUTION_POLICY } from './policy-types.js';

describe('normalizeContextPolicy', () => {
  it('keeps a valid policy untouched', () => {
    const p = { tokenBudget: 4000, optimizationBudget: 200, confidenceFloor: 0.4 };
    expect(normalizeContextPolicy(p)).toEqual(p);
  });

  // Upwards, not to zero. A negative budget is a bug in whatever computed it,
  // and answering it with "no context at all" would turn that bug into a
  // starved agent — the exact failure the fail-open-upward rule exists to stop.
  it('answers a negative budget with the safe default rather than nothing', () => {
    const p = normalizeContextPolicy({ tokenBudget: -1, optimizationBudget: -50, confidenceFloor: 0.5 });
    expect(p.tokenBudget).toBe(DEFAULT_CONTEXT_POLICY.tokenBudget);
    expect(p.optimizationBudget).toBe(DEFAULT_CONTEXT_POLICY.optimizationBudget);
    expect(p.tokenBudget).toBeGreaterThanOrEqual(0);
  });

  it('allows a deliberate zero budget — that is how context is switched off', () => {
    expect(normalizeContextPolicy({ ...DEFAULT_CONTEXT_POLICY, tokenBudget: 0 }).tokenBudget).toBe(0);
  });

  it('clamps the confidence floor into [0,1]', () => {
    expect(normalizeContextPolicy({ ...DEFAULT_CONTEXT_POLICY, confidenceFloor: 2 }).confidenceFloor).toBe(1);
    expect(normalizeContextPolicy({ ...DEFAULT_CONTEXT_POLICY, confidenceFloor: -2 }).confidenceFloor).toBe(0);
  });

  it('falls back to the default for a non-finite field rather than propagating NaN', () => {
    const p = normalizeContextPolicy({ tokenBudget: NaN, optimizationBudget: Infinity, confidenceFloor: NaN });
    expect(p).toEqual(DEFAULT_CONTEXT_POLICY);
  });
});

describe('normalizeExecutionPolicy', () => {
  it('keeps hardTurnCap at or above one', () => {
    expect(normalizeExecutionPolicy({ ...DEFAULT_EXECUTION_POLICY, hardTurnCap: 0 }).hardTurnCap).toBe(1);
    expect(normalizeExecutionPolicy({ ...DEFAULT_EXECUTION_POLICY, hardTurnCap: -9 }).hardTurnCap).toBe(1);
  });

  it('never lets the soft target exceed the hard cap', () => {
    const p = normalizeExecutionPolicy({ ...DEFAULT_EXECUTION_POLICY, softTurnTarget: 90, hardTurnCap: 30 });
    expect(p.softTurnTarget).toBe(30);
    expect(p.softTurnTarget).toBeLessThanOrEqual(p.hardTurnCap);
  });

  it('keeps the spend cap non-negative', () => {
    expect(normalizeExecutionPolicy({ ...DEFAULT_EXECUTION_POLICY, spendCapUsd: -1 }).spendCapUsd)
      .toBeGreaterThanOrEqual(0);
  });

  it('clamps the two normalized signals into [0,1]', () => {
    const p = normalizeExecutionPolicy({ ...DEFAULT_EXECUTION_POLICY, explorationTolerance: 5, confidenceRequirement: -5 });
    expect(p.explorationTolerance).toBe(1);
    expect(p.confidenceRequirement).toBe(0);
  });

  it('rounds turn bounds to whole turns — half a turn is not a thing', () => {
    const p = normalizeExecutionPolicy({ ...DEFAULT_EXECUTION_POLICY, softTurnTarget: 12.7, hardTurnCap: 40.2 });
    expect(Number.isInteger(p.softTurnTarget)).toBe(true);
    expect(Number.isInteger(p.hardTurnCap)).toBe(true);
  });

  it('holds every invariant at once on the defaults', () => {
    const p = DEFAULT_EXECUTION_POLICY;
    expect(p.hardTurnCap).toBeGreaterThanOrEqual(1);
    expect(p.softTurnTarget).toBeLessThanOrEqual(p.hardTurnCap);
    expect(p.spendCapUsd).toBeGreaterThanOrEqual(0);
    expect(p.optimizationBudget).toBeGreaterThanOrEqual(0);
    expect(p.contextBudget).toBeGreaterThanOrEqual(0);
  });
});
