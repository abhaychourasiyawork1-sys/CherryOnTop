import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PROMPT_BUDGET, usableTokens, effectiveInputTokens, pressureOf, type PromptBudget,
} from './prompt-budget.js';

const budget = (over: Partial<PromptBudget> = {}): PromptBudget => ({ ...DEFAULT_PROMPT_BUDGET, ...over });

describe('usable window', () => {
  it('subtracts every reservation from the provider limit', () => {
    const b = budget({
      providerContextLimit: 100_000, toolSchemaTokens: 10_000, outputReserveTokens: 20_000,
      recoveryReserveTokens: 5_000, safetyMarginTokens: 5_000,
    });
    expect(usableTokens(b)).toBe(60_000);
  });

  it('never goes negative when the reservations exceed the window', () => {
    expect(usableTokens(budget({ providerContextLimit: 1_000 }))).toBe(0);
    expect(effectiveInputTokens(budget({ providerContextLimit: 1_000 }))).toBe(0);
  });

  it('gives the argv only its share of the usable window', () => {
    const b = budget({
      providerContextLimit: 100_000, toolSchemaTokens: 0, outputReserveTokens: 0,
      recoveryReserveTokens: 0, safetyMarginTokens: 0, argvShare: 0.25,
    });
    expect(effectiveInputTokens(b)).toBe(25_000);
  });
});

describe('context pressure', () => {
  const b = budget({
    providerContextLimit: 100_000, toolSchemaTokens: 0, outputReserveTokens: 0,
    recoveryReserveTokens: 0, safetyMarginTokens: 0,
  });

  it.each([
    [0, 'LOW'], [49_999, 'LOW'], [50_000, 'MODERATE'], [74_999, 'MODERATE'],
    [75_000, 'HIGH'], [89_999, 'HIGH'], [90_000, 'CRITICAL'], [250_000, 'CRITICAL'],
  ])('%i visible tokens is %s', (visible, state) => {
    expect(pressureOf(visible, b).state).toBe(state);
  });

  it('reports the ratio against the usable window, not the provider limit', () => {
    const tight = budget({ ...b, safetyMarginTokens: 50_000 });
    expect(pressureOf(25_000, tight).ratio).toBeCloseTo(0.5);
  });

  it('is CRITICAL when there is no usable window at all', () => {
    expect(pressureOf(1, budget({ providerContextLimit: 0 })).state).toBe('CRITICAL');
  });
});
