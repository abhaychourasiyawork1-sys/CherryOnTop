import { describe, it, expect, vi } from 'vitest';
import { assessDecomposability } from './decomposability.js';
import { createSystem1 } from './guard.js';
import { ProviderFailure, type System1Provider } from './provider.js';
import { assessDecomposition } from '../intelligence/decompose.js';
import { decideExecution } from '../engines/decide-execution.js';
import type { DecisionRequest } from './types.js';
import type { Authority } from '../schemas/node-contract.js';

const authority = (over: Partial<Authority> = {}): Authority => ({
  budget_usd: 5, spawn_children: true, max_child_count: 4, tools: [], ...over,
});

function laya(p: number | Error): System1Provider & { decide: ReturnType<typeof vi.fn> } {
  return {
    name: 'laya',
    decide: vi.fn(async (rs: readonly DecisionRequest[]) => {
      if (p instanceof Error) throw p;
      return rs.map((r) => ({
        requestId: r.id, provider: 'laya' as const, surface: r.surface, primitive: r.primitive, result: { probability: p },
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
// Medium complexity: several work types across broad scope, no explicit request.
const AMBIGUOUS = 'Audit every module for dead code and also document the public services';

describe('execution.decomposable ownership', () => {
  it('still extracts the useful facts from the historical coherent investigation', () => {
    const facts = assessDecomposition(HISTORICAL).signals;
    expect(facts.breadth_terms).toBeGreaterThan(0);
    expect(facts).toHaveProperty('distinct_work_types');
    expect(facts).toHaveProperty('named_single_targets');
    expect(assessDecomposition(HISTORICAL).investigative).toBe(true);
  });

  it('keeps an explicit parallelization request deterministic, without asking', async () => {
    const { provider, s1: sys } = s1(0.01);
    const r = await assessDecomposability({ scope: 'n', goal: 'Split this across 4 agents in parallel: lint, test, docs, types', authority: authority(), existingChildren: 0 }, sys);
    expect(r.bundle.worthSplitting).toBe(true);
    expect(r.gate).toBe('explicit-split-request');
    expect(provider.decide).not.toHaveBeenCalled();
  });

  it('short-circuits without System-1 when delegation is unavailable', async () => {
    const { provider, s1: sys } = s1(0.99);
    for (const over of [{ spawn_children: false }, { max_child_count: 1 }]) {
      const r = await assessDecomposability({ scope: 'n', goal: AMBIGUOUS, authority: authority(over), existingChildren: 0 }, sys);
      expect(r.bundle.worthSplitting).toBe(false);
    }
    const again = await assessDecomposability({ scope: 'n', goal: AMBIGUOUS, authority: authority(), existingChildren: 2 }, sys);
    expect(again.gate).toBe('already-delegated');
    expect(provider.decide).not.toHaveBeenCalled();
  });

  it('does not ask when no answer could make economics delegate', async () => {
    const { provider, s1: sys } = s1(0.99);
    const r = await assessDecomposability({ scope: 'n', goal: 'fix the typo in README.md', authority: authority(), existingChildren: 0 }, sys);
    expect(r.gate).toBe('economics-would-not-delegate');
    expect(provider.decide).not.toHaveBeenCalled();
  });

  it('asks System-1 about an ambiguous goal and hands the answer to deterministic economics', async () => {
    expect(assessDecomposition(AMBIGUOUS).complexity).not.toBe('low');
    const yes = await assessDecomposability({ scope: 'a', goal: AMBIGUOUS, authority: authority(), existingChildren: 0 }, s1(0.9).s1);
    const no = await assessDecomposability({ scope: 'b', goal: AMBIGUOUS, authority: authority(), existingChildren: 0 }, s1(0.05).s1);
    expect(yes.bundle.signals.system1_asked).toBe(1);
    expect(yes.bundle.worthSplitting).toBe(true);
    expect(no.bundle.worthSplitting).toBe(false);
    // Economics, not System-1, still decides the outcome.
    const decide = (worthSplitting: boolean, budget = 5) => decideExecution({
      goal: AMBIGUOUS, authority: authority({ budget_usd: budget }), complexity: yes.bundle.complexity, worthSplitting,
    }).outcome;
    expect(decide(yes.bundle.worthSplitting)).toBe('DELEGATE');
    expect(decide(no.bundle.worthSplitting)).toBe('SELF_EXECUTE');
    expect(decide(yes.bundle.worthSplitting, 0.5)).toBe('ESCALATE');
  });

  it('on provider failure, does not split and does not consult the old heuristic', async () => {
    // The regex verdict for this goal would be "split"; the fallback must not be.
    expect(assessDecomposition(AMBIGUOUS).worthSplitting).toBe(true);
    const r = await assessDecomposability(
      { scope: 'n', goal: AMBIGUOUS, authority: authority(), existingChildren: 0 },
      s1(new ProviderFailure('timeout', 'slow')).s1,
    );
    expect(r.bundle.worthSplitting).toBe(false);
    expect(r.bundle.signals.system1_fallback).toBe(1);
    expect(r.fallbackReason).toMatch(/slow/);
  });
});
