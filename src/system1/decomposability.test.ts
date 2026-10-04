import { describe, it, expect, vi } from 'vitest';
import { assessDecomposability } from './decomposability.js';
import { decompositionBoundary } from './economic-mapping.js';
import { createSystem1 } from './guard.js';
import { ProviderFailure, type System1Provider } from './provider.js';
import { decideExecution, type DelegationPricing } from '../engines/decide-execution.js';
import type { DecisionRequest } from './types.js';
import type { Authority } from '../schemas/node-contract.js';

const authority = (over: Partial<Authority> = {}): Authority => ({
  budget_usd: 5, spawn_children: true, max_child_count: 4, tools: [], ...over,
});

const price = (expectedUsd: number) => ({ expectedUsd, conservativeUsd: expectedUsd * 1.2 });
// Doing the work whole costs 1; splitting it costs .05 + .3 + .05 when it splits.
const DEARER_WHOLE: DelegationPricing = {
  solo: price(1), plan: price(0.05), children: price(0.3), synth: price(0.05), childCount: 2,
};
const CHEAPER_WHOLE: DelegationPricing = {
  solo: price(0.2), plan: price(0.1), children: price(0.15), synth: price(0.05), childCount: 2,
};
const BOUNDARY = decompositionBoundary(DEARER_WHOLE);

function laya(p: number | Error): System1Provider & { decide: ReturnType<typeof vi.fn> } {
  return {
    name: 'laya',
    decide: vi.fn(async (rs: readonly DecisionRequest[]) => {
      if (p instanceof Error) throw p;
      return rs.map((r) => ({
        // The staffing choice: raw probability `p` on "many".
        requestId: r.id, provider: 'laya' as const, surface: r.surface, primitive: r.primitive,
        result: { selectedId: p >= 0.5 ? 'many' : 'one', probabilities: { many: p, one: 1 - p } },
        calibration: { rawProbability: p, version: 'x' }, confidence: { provider: 0.6, orchestration: 0 },
        metadata: { model: 'typed-decisions', questionVersion: r.questionVersion, inputDigest: r.inputDigest, stateVersion: r.stateVersion, latencyMs: 4, inputTokens: 60 },
      }));
    }),
  };
}

const s1 = (p: number | Error) => {
  const provider = laya(p);
  return { provider, s1: createSystem1(provider, { maxCallsPerScope: 5, timeoutMs: 1_000 }) };
};

const HISTORICAL = 'Review the codebase and check for bugs, no edits';
const AMBIGUOUS = 'Audit every module for dead code and also document the public services';
const ask = (goal: string, over: Partial<Parameters<typeof assessDecomposability>[0]> = {}) => ({
  scope: 'n', goal, authority: authority(), existingChildren: 0, boundary: BOUNDARY, ...over,
});

describe('execution.decomposable ownership', () => {
  it('asks System-1 about every goal it may split, and reads nothing from the wording', async () => {
    for (const goal of [HISTORICAL, AMBIGUOUS, 'Split this across 4 agents in parallel: lint, test, docs, types', 'fix the typo in README.md']) {
      const { provider, s1: sys } = s1(0.5);
      const r = await assessDecomposability(ask(goal), sys);
      expect(r.gate, goal).toBeUndefined();
      expect(provider.decide, goal).toHaveBeenCalledTimes(1);
    }
  });

  it('does not treat an explicit request to parallelise as settled: System-1 still answers', async () => {
    const { provider, s1: sys } = s1(0.01);
    const r = await assessDecomposability(ask('Split this across 4 agents in parallel: lint, test, docs, types'), sys);
    expect(r.bundle.splitProbability).toBeLessThan(0.5);
    expect(provider.decide).toHaveBeenCalled();
  });

  it('short-circuits without System-1 when delegation is unavailable', async () => {
    const { provider, s1: sys } = s1(0.99);
    for (const over of [{ spawn_children: false }, { max_child_count: 1 }]) {
      const r = await assessDecomposability(ask(AMBIGUOUS, { authority: authority(over) }), sys);
      expect(r.bundle.splitProbability).toBeUndefined();
    }
    const again = await assessDecomposability(ask(AMBIGUOUS, { existingChildren: 2 }), sys);
    expect(again.gate).toBe('already-delegated');
    expect(provider.decide).not.toHaveBeenCalled();
  });

  it('does not ask when the market says no answer could make delegating cheaper', async () => {
    const { provider, s1: sys } = s1(0.99);
    const r = await assessDecomposability(ask('anything', { boundary: decompositionBoundary(CHEAPER_WHOLE) }), sys);
    expect(r.gate).toBe('economics-would-not-delegate');
    expect(provider.decide).not.toHaveBeenCalled();
  });

  it('asks System-1 and hands the answer to deterministic economics', async () => {
    const yes = await assessDecomposability(ask(AMBIGUOUS, { scope: 'a' }), s1(0.9).s1);
    const no = await assessDecomposability(ask(AMBIGUOUS, { scope: 'b' }), s1(0.05).s1);
    expect(yes.bundle.signals.system1_asked).toBe(1);
    expect(yes.bundle.signals.system1_worth_splitting).toBe(1);
    expect(no.bundle.signals.system1_worth_splitting).toBe(0);
    // Economics, not System-1, still decides the outcome.
    const decide = (splitProbability: number | undefined, budget = 5) => decideExecution({
      goal: AMBIGUOUS, authority: authority({ budget_usd: budget }), pricing: DEARER_WHOLE,
      ...(splitProbability === undefined ? {} : { splitProbability }),
    }).outcome;
    expect(decide(yes.bundle.splitProbability)).toBe('DELEGATE');
    expect(decide(no.bundle.splitProbability)).toBe('SELF_EXECUTE');
    expect(decide(yes.bundle.splitProbability, 0.1)).toBe('ESCALATE');
  });

  it('asks a described two-way staffing choice and reads the calibrated "many"', async () => {
    const { provider, s1: sys } = s1(0.6);
    const r = await assessDecomposability(ask(AMBIGUOUS), sys);
    const asked = provider.decide.mock.calls[0][0][0] as DecisionRequest;
    expect(asked.primitive).toBe('choice');
    expect(asked.candidates.map((c) => c.id)).toEqual(['one', 'many']);
    expect(asked.questionVersion).toBe('execution.decomposable@2');
    // Raw 0.6 on a biased centre is not 0.6: the fitted calibrator moved it.
    expect(r.outcome?.judgment?.calibration.version).toBe('platt-decomposable@1');
    expect(r.bundle.signals.system1_p_decomposable).not.toBeCloseTo(0.6, 2);
  });

  it('keeps the historical coherent review single after calibration', async () => {
    // 0.35 is what live Laya (typed-decisions) returned for this goal.
    const r = await assessDecomposability(ask(HISTORICAL, { scope: 'h' }), s1(0.35).s1);
    expect(r.bundle.signals.system1_asked).toBe(1);
    expect(r.bundle.signals.system1_worth_splitting).toBe(0);
  });

  it('on provider failure, says nothing about splitting and consults no heuristic', async () => {
    const r = await assessDecomposability(ask(AMBIGUOUS), s1(new ProviderFailure('timeout', 'slow')).s1);
    expect(r.bundle.splitProbability).toBeUndefined();
    expect(r.bundle.signals.system1_fallback).toBe(1);
    expect(r.fallbackReason).toMatch(/slow/);
  });
});
