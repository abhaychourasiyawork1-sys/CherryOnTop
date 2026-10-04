/** The market assumes nothing about a setup it has not been shown.
 *
 *  The same history, told in two vocabularies — different model names, a
 *  different order of offering them — must produce the same decision. If a name
 *  or a position ever leaks into a choice (a price table read as strength, a
 *  list read as a ladder), one of these two universes picks differently. */
import { describe, it, expect } from 'vitest';
import { generateExecutionCandidates, executionEstimate, candidateKeyFor, modelKeyFor } from './model-router.js';
import { fitCapability, type CapabilityObservation } from './capability.js';
import { chooseEconomicAction } from '../decision/engine.js';
import { initialEconomicState } from '../decision/state.js';
import type { HarnessCapabilitySnapshot } from '../adapters/adapter.js';

const universe = (models: string[]): HarnessCapabilitySnapshot => ({
  harness: 'h', acceptsModelFlag: true, serves: () => true, efforts: ['default'], models,
  supportsSession: false, health: 'healthy', fingerprint: 'fp',
});

/** Underlying candidates: what each does, independent of what it is called. */
const truth = {
  a: [{ d: 0.9, ok: true }, { d: 0.9, ok: true }, { d: 0.9, ok: true }, { d: 0.9, ok: true }, { d: 0.9, ok: true },
      { d: 0.9, ok: true }, { d: 0.9, ok: true }, { d: 0.9, ok: true }, { d: 0.9, ok: true }, { d: 0.9, ok: true }],
  b: Array.from({ length: 10 }, () => ({ d: 0.9, ok: false })),
  c: [...Array.from({ length: 10 }, () => ({ d: 0.2, ok: true })), ...Array.from({ length: 10 }, () => ({ d: 0.9, ok: false }))],
} as const;

function decide(names: Record<'a' | 'b' | 'c', string>, order: Array<'a' | 'b' | 'c'>, difficulty: number): 'a' | 'b' | 'c' {
  const observations: CapabilityObservation[] = (Object.keys(truth) as Array<'a' | 'b' | 'c'>).flatMap((k) =>
    truth[k].map((o) => ({
      modelKey: modelKeyFor('execute', 'h', names[k]), candidateKey: candidateKeyFor('execute', 'h', names[k], 'default'),
      facts: {}, difficulty: o.d, validated: o.ok, weight: 1,
    })));
  const candidates = generateExecutionCandidates({
    role: 'execute', difficulty, difficultyUpper: Math.min(1, difficulty + 0.05), dispatchTokens: 40_000, dispatchLatencyMs: 1,
    harnesses: [universe(order.map((k) => names[k]))], capability: fitCapability(observations),
  }).filter((c) => c.metadata.model !== undefined);
  const state = initialEconomicState({ goal: 'g', totalTokenBudget: 2_000_000 });
  const chosen = chooseEconomicAction({
    state, candidates, estimates: Object.fromEntries(candidates.map((c) => [c.id, executionEstimate(c, state)])),
  }).action.metadata.model as string;
  return (Object.keys(names) as Array<'a' | 'b' | 'c'>).find((k) => names[k] === chosen)!;
}

describe('decisions do not depend on what candidates are called or where they are listed', () => {
  const one = { a: 'zeta-9', b: 'alpha-1', c: 'mid-5' };
  const two = { a: 'quux', b: 'foo', c: 'bar' };

  for (const difficulty of [0.2, 0.6, 0.9]) {
    it(`picks the same underlying candidate at difficulty ${difficulty}`, () => {
      const first = decide(one, ['a', 'b', 'c'], difficulty);
      expect(decide(two, ['c', 'a', 'b'], difficulty)).toBe(first);
      expect(decide(two, ['b', 'c', 'a'], difficulty)).toBe(first);
    });
  }

  it('sends hard work to the candidate that has shown it can do it, whatever it is called', () => {
    expect(decide(one, ['a', 'b', 'c'], 0.9)).toBe('a');
    expect(decide(two, ['b', 'c', 'a'], 0.9)).toBe('a');
  });
});
