import { describe, it, expect, afterEach } from 'vitest';
import { contextPolicyFor, executionPolicyFor, CONTEXT_POLICY_VERSION, EXECUTION_POLICY_VERSION } from './policy.js';
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
});
