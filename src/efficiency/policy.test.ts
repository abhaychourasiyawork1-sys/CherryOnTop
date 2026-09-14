import { describe, it, expect, afterEach } from 'vitest';
import { contextPolicyFor, executionPolicyFor, executionPolicyForGoal, effectiveTurnCap, currentPolicyVersions, CONTEXT_POLICY_VERSION, EXECUTION_POLICY_VERSION } from './policy.js';
import { normalizeTaskSignals, UNKNOWN_SIGNALS } from './task-signals.js';
import { taskEconomicsFor } from './task-economics.js';
import type { TaskEconomicsSignals } from './policy-types.js';

const signals = (over: Partial<TaskEconomicsSignals>): TaskEconomicsSignals =>
  normalizeTaskSignals({ ...UNKNOWN_SIGNALS, ...over });

const TINY = signals({ complexityBand: 'tiny', confidence: 0.9, breadth: 0, hasExplicitAnchors: true, expectedModificationScope: 0.1, investigationLikelihood: 0.1, verificationNeed: 0.4 });
const BROAD = signals({ complexityBand: 'large', confidence: 0.35, breadth: 1, hasExplicitAnchors: false, expectedModificationScope: 0.8, investigationLikelihood: 0.9 });
const VAGUE = signals({ complexityBand: 'unknown', confidence: 0.05, breadth: 0.2, hasExplicitAnchors: false });
const NORMAL = signals({ complexityBand: 'medium', confidence: 0.6, breadth: 0.3, hasExplicitAnchors: true });

afterEach(() => { delete process.env.ORG_REPO_MAP_TOKENS; delete process.env.ORG_TASK_SPEND_CAP_USD; });

describe('contextPolicyFor', () => {
  it('gives a tiny anchored task far less context than a broad one', () => {
    expect(contextPolicyFor(TINY).tokenBudget).toBeLessThan(contextPolicyFor(BROAD).tokenBudget / 2);
  });

  it('never exceeds the configured ceiling', () => {
    process.env.ORG_REPO_MAP_TOKENS = '2000';
    for (const s of [TINY, BROAD, VAGUE, NORMAL]) {
      expect(contextPolicyFor(s).tokenBudget).toBeLessThanOrEqual(2000);
    }
  });

  it('widens rather than prunes when confidence is low', () => {
    const confident = signals({ ...NORMAL, confidence: 0.95 });
    const unsure = signals({ ...NORMAL, confidence: 0.05 });
    expect(contextPolicyFor(unsure).tokenBudget).toBeGreaterThan(contextPolicyFor(confident).tokenBudget);
  });

  it('spends less deciding on a tiny task than on a broad one', () => {
    expect(contextPolicyFor(TINY).optimizationBudget)
      .toBeLessThan(contextPolicyFor(BROAD).optimizationBudget);
  });

  it('keeps optimization overhead a small fraction of the context it buys', () => {
    for (const s of [TINY, BROAD, VAGUE, NORMAL]) {
      const p = contextPolicyFor(s);
      expect(p.optimizationBudget).toBeLessThanOrEqual(p.tokenBudget * 0.15 + 1);
    }
  });

  it('switches off cleanly when the ceiling is zero', () => {
    process.env.ORG_REPO_MAP_TOKENS = '0';
    expect(contextPolicyFor(BROAD).tokenBudget).toBe(0);
    expect(contextPolicyFor(BROAD).optimizationBudget).toBe(0);
  });

  it('holds its invariants for every derived signal set', () => {
    for (const goal of ['Fix the typo in README.md', 'Review the entire codebase', 'Add a test for src/a.ts', '']) {
      const p = contextPolicyFor(taskEconomicsFor(goal));
      expect(p.tokenBudget).toBeGreaterThanOrEqual(0);
      expect(p.optimizationBudget).toBeGreaterThanOrEqual(0);
      expect(p.confidenceFloor).toBeGreaterThanOrEqual(0);
      expect(p.confidenceFloor).toBeLessThanOrEqual(1);
    }
  });
});

describe('executionPolicyFor', () => {
  it('caps a tiny task at far fewer turns than a broad one', () => {
    expect(executionPolicyFor(TINY).hardTurnCap).toBeLessThan(executionPolicyFor(BROAD).hardTurnCap);
  });

  it('keeps the soft target at or below the hard cap, always', () => {
    for (const s of [TINY, BROAD, VAGUE, NORMAL]) {
      const p = executionPolicyFor(s);
      expect(p.softTurnTarget).toBeLessThanOrEqual(p.hardTurnCap);
      expect(p.hardTurnCap).toBeGreaterThanOrEqual(1);
    }
  });

  it('tolerates more exploration on an investigation than on a one-file edit', () => {
    expect(executionPolicyFor(BROAD).explorationTolerance)
      .toBeGreaterThan(executionPolicyFor(TINY).explorationTolerance);
  });

  it('is more conservative under low confidence, not more aggressive', () => {
    const unsure = executionPolicyFor(VAGUE);
    const sure = executionPolicyFor(signals({ ...NORMAL, confidence: 0.95 }));
    // More headroom to find its footing, and a lower bar to count as progress.
    expect(unsure.hardTurnCap).toBeGreaterThanOrEqual(sure.hardTurnCap);
    expect(unsure.confidenceRequirement).toBeLessThanOrEqual(sure.confidenceRequirement);
  });

  it('reads the deployment spend cap', () => {
    process.env.ORG_TASK_SPEND_CAP_USD = '2.5';
    expect(executionPolicyFor(NORMAL).spendCapUsd).toBe(2.5);
  });

  it('defaults to no spend ceiling of its own', () => {
    expect(executionPolicyFor(NORMAL).spendCapUsd).toBe(0);
  });
});

describe('policy versions', () => {
  it('are stable, non-empty identifiers', () => {
    expect(CONTEXT_POLICY_VERSION).toMatch(/^ctx-/);
    expect(EXECUTION_POLICY_VERSION).toMatch(/^exec-/);
  });

  it('report the planner that is actually running, read at record time', () => {
    expect(currentPolicyVersions().context).toBe(CONTEXT_POLICY_VERSION);
    process.env.ORG_CONTEXT_PLANNER = 'off';
    // A deployment that switches the planner off mid-run must produce rows that
    // say so, or a comparison across the switch averages two systems into one
    // number describing neither.
    expect(currentPolicyVersions().context).toBe('lexical');
    delete process.env.ORG_CONTEXT_PLANNER;
  });
});

describe('effectiveTurnCap', () => {
  const policy = (hardTurnCap: number) => ({ ...executionPolicyFor(NORMAL), hardTurnCap });

  it('takes the tighter of the configured breaker and the policy', () => {
    expect(effectiveTurnCap(60, policy(20))).toBe(20);
    expect(effectiveTurnCap(10, policy(45))).toBe(10);
  });

  it('leaves an operator-disabled breaker disabled', () => {
    // ORG_MAX_TURNS_EXECUTE=0 reaches here as undefined. A policy must not be
    // able to switch a breaker back on that someone deliberately switched off.
    expect(effectiveTurnCap(undefined, policy(20))).toBeUndefined();
  });

  it('gives a tiny task a far tighter cap than a broad one, under one config', () => {
    const tiny = effectiveTurnCap(60, executionPolicyFor(TINY))!;
    const broad = effectiveTurnCap(60, executionPolicyFor(BROAD))!;
    expect(tiny).toBeLessThan(broad);
    expect(tiny).toBeGreaterThanOrEqual(1);
  });
});

describe('executionPolicyForGoal', () => {
  it('derives from the goal like the direct call does', () => {
    expect(executionPolicyForGoal('Fix the typo in README.md'))
      .toEqual(executionPolicyFor(taskEconomicsFor('Fix the typo in README.md')));
  });

  it('falls back to the fixed policy rather than throwing the dispatch away', () => {
    // A goal object that explodes the moment anything reads it. Both callers of
    // this sit where a throw fails a dispatch or a whole task, so a policy that
    // cannot be derived must cost adaptivity and nothing else.
    const hostile = { toString() { throw new Error('boom'); } } as unknown as string;
    const policy = executionPolicyForGoal(hostile);
    expect(policy.hardTurnCap).toBeGreaterThanOrEqual(1);
    expect(policy.softTurnTarget).toBeLessThanOrEqual(policy.hardTurnCap);
  });

  it('still honours the configured breaker in the fallback', () => {
    process.env.ORG_MAX_TURNS_EXECUTE = '7';
    const hostile = { toString() { throw new Error('boom'); } } as unknown as string;
    expect(executionPolicyForGoal(hostile).hardTurnCap).toBe(7);
    delete process.env.ORG_MAX_TURNS_EXECUTE;
  });
});

describe('the policy generation a run reports', () => {
  afterEach(() => {
    delete process.env.ORG_CONTEXT_PLANNER;
    delete process.env.ORG_EFFICIENCY_MODE;
  });

  it('names the component versions and a composite to join on', () => {
    const versions = currentPolicyVersions();
    expect(versions.context).toBe(CONTEXT_POLICY_VERSION);
    expect(versions.execution).toBe(EXECUTION_POLICY_VERSION);
    // The components are what a person reads; the composite is what a
    // comparison joins on.
    expect(versions.policy).toContain(versions.context);
    expect(versions.policy).toContain(versions.execution);
  });

  it('says so when the planner is off, rather than reporting a generation it is not running', () => {
    process.env.ORG_CONTEXT_PLANNER = 'off';
    const versions = currentPolicyVersions();
    expect(versions.context).toBe('lexical');
    expect(versions.policy).toContain('lexical');
  });

  it('distinguishes the two arms', () => {
    process.env.ORG_EFFICIENCY_MODE = 'disabled';
    const baseline = currentPolicyVersions().policy;
    process.env.ORG_EFFICIENCY_MODE = 'enabled';
    const full = currentPolicyVersions().policy;
    expect(baseline).not.toBe(full);
  });
});
