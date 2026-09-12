import { describe, it, expect, afterEach } from 'vitest';
import {
  hardGates, decideExecutionPath, decideEvidence, decideSynthesis, decideModel,
} from './engine.js';
import { EMPTY_FRONTIER, updateFrontier } from '../context/frontier.js';
import type { EvidenceCandidate } from '../execution/evidence-planner.js';
import type { Authority } from '../schemas/node-contract.js';

const authority = (over: Partial<Authority> = {}): Authority => ({
  tools: [], spawn_children: true, max_child_count: 2, budget_usd: 5, ...over,
});

const dispatch = { tokens: 1_772_218, latencyMs: 263_000, costUsd: 0.95 };
const ref = (id: string) => ({ semanticId: id, version: 1, contentHash: `h-${id}` });

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

  it('fires before economics could ever be consulted', () => {
    // A boundary that a good enough score can buy is not a boundary.
    const decision = decideExecutionPath({
      goal: 'Fix authentication, add tests, and update the docs',
      authority: authority({ budget_usd: 1 }), spentUsd: 5,
      complexity: 'high', worthSplitting: true, dispatch,
    });
    expect(decision.chosen).toBe('STOP');
    expect(decision.gate).toBe('budget');
  });
});

describe('free before scored', () => {
  it('reuses an exact result without scoring anything against it', () => {
    const decision = decideExecutionPath({
      goal: 'Review the README', authority: authority(), spentUsd: 0,
      complexity: 'medium', worthSplitting: true, dispatch,
      reusable: { tokens: 1_772_218, costUsd: 0.95 },
    });
    expect(decision.chosen).toBe('REUSE_COMPUTATION');
    expect(decision.fastPath).toBe(true);
    expect(decision.estimate.tokens).toBe(0);
    // ...and still names what it did not do, with what that would have cost.
    expect(decision.alternatives[0].type).toBe('RUN_MODEL');
    expect(decision.alternatives[0].estimate.tokens).toBe(1_772_218);
  });

  it('does not spawn an agent when the evidence already closes the question', () => {
    const closed = updateFrontier(EMPTY_FRONTIER, { learned: [ref('a')] });
    const decision = decideExecutionPath({
      goal: 'Audit every module and add tests and update the docs',
      authority: authority(), spentUsd: 0,
      complexity: 'high', worthSplitting: true, dispatch, frontier: closed,
    });
    expect(decision.chosen).toBe('STOP');
    expect(decision.reason).toMatch(/already held closes/);
  });

  it('still works when the frontier is closed only because nothing was ever asked', () => {
    // An empty frontier is not evidence of completeness.
    const decision = decideExecutionPath({
      goal: 'Fix the typo in the README', authority: authority(), spentUsd: 0,
      complexity: 'low', worthSplitting: false, dispatch, frontier: EMPTY_FRONTIER,
    });
    expect(decision.chosen).toBe('RUN_MODEL');
  });
});

describe('the existing economics, in the common shape', () => {
  it('runs a coherent goal itself rather than splitting it', () => {
    const decision = decideExecutionPath({
      goal: 'Review the codebase and find bugs', authority: authority(), spentUsd: 0,
      complexity: 'medium', worthSplitting: false, dispatch,
    });
    expect(decision.chosen).toBe('RUN_MODEL');
    expect(decision.reason).toMatch(/one unit of work/);
    expect(decision.alternatives[0].type).toBe('SPAWN_AGENT');
  });

  it('spawns agents for genuinely separate workstreams, and prices the fan-out', () => {
    const decision = decideExecutionPath({
      goal: 'Fix auth, optimise the query layer, and add API tests',
      authority: authority(), spentUsd: 0, complexity: 'high', worthSplitting: true, dispatch,
    });
    expect(decision.chosen).toBe('SPAWN_AGENT');
    // A fan-out is not the cost of one dispatch.
    expect(decision.estimate.tokens).toBeGreaterThan(dispatch.tokens);
  });

  it('reports a margin as confidence, so a coin toss reads as one', () => {
    // The medium-complexity default scores 0.3 against a threshold of 0.3.
    const marginal = decideExecutionPath({
      goal: 'g', authority: authority(), spentUsd: 0, complexity: 'medium', worthSplitting: true, dispatch,
    });
    const clear = decideExecutionPath({
      goal: 'g', authority: authority(), spentUsd: 0, complexity: 'low', worthSplitting: true, dispatch,
    });
    expect(marginal.confidence).toBeCloseTo(0.5, 2);
    expect(clear.confidence).toBeGreaterThan(marginal.confidence);
  });

  it('waits rather than escalating past a budget floor', () => {
    const decision = decideExecutionPath({
      goal: 'g', authority: authority({ budget_usd: 0.5 }), spentUsd: 0,
      complexity: 'high', worthSplitting: true, dispatch,
    });
    expect(decision.chosen).toBe('WAIT');
    expect(decision.gate).toBe('budget-floor');
  });
});

describe('evidence', () => {
  const open = updateFrontier(EMPTY_FRONTIER, { raised: [ref('a')] });
  const candidate = (over: Partial<EvidenceCandidate>): EvidenceCandidate => ({
    action: 'run_model', estimatedTokens: 1_000_000, estimatedLatencyMs: 200_000,
    expectedGain: 0.9, reason: 'a dispatch', ...over,
  });

  it('prefers a deterministic tool to a model when both would settle it', () => {
    const decision = decideEvidence({
      authority: authority(), spentUsd: 0, frontier: open,
      candidates: [candidate({}), candidate({ action: 'search', estimatedTokens: 200, estimatedLatencyMs: 500, expectedGain: 0.4, reason: 'a search' })],
    });
    expect(decision.chosen).toBe('RUN_TOOL');
    expect(decision.alternatives.map((a) => a.type)).toContain('RUN_MODEL');
  });

  it('reuses what is held, on the fast path', () => {
    const decision = decideEvidence({
      authority: authority(), spentUsd: 0, frontier: open,
      candidates: [candidate({ action: 'reuse', estimatedTokens: 0, estimatedLatencyMs: 0, expectedGain: 1, reason: 'held' })],
    });
    expect(decision.chosen).toBe('REUSE_CONTEXT');
    expect(decision.fastPath).toBe(true);
  });

  it('stops rather than gathering evidence nobody needs', () => {
    const decision = decideEvidence({
      authority: authority(), spentUsd: 0, frontier: EMPTY_FRONTIER, candidates: [candidate({})],
    });
    expect(decision.chosen).toBe('STOP');
  });
});

describe('synthesis', () => {
  const synthesis = { tokens: 27_346, latencyMs: 19_000, costUsd: 0.032 };
  const report = (goal: string, text: string) => ({ goal, succeeded: true, report: text });
  const enveloped = (summary: string, files: string[] = []) =>
    `prose\n\`\`\`json\n${JSON.stringify({ status: 'success', summary, findings: [], changedFiles: files, uncertainties: [], confidence: 0.9 })}\n\`\`\``;

  it('does not pay a model to reword a single answer', () => {
    const decision = decideSynthesis({
      authority: authority(), spentUsd: 0, synthesis,
      children: [report('a', enveloped('done a'))],
    });
    expect(decision.chosen).toBe('STOP');
    expect(decision.fastPath).toBe(true);
    expect(decision.alternatives[0].estimate.tokens).toBe(27_346);
  });

  it('merges compatible reports mechanically', () => {
    const decision = decideSynthesis({
      authority: authority(), spentUsd: 0, synthesis,
      children: [report('a', enveloped('done a', ['a.ts'])), report('b', enveloped('done b', ['b.ts']))],
    });
    expect(decision.chosen).toBe('STOP');
    expect(decision.reason).toMatch(/merge mechanically/);
  });

  it('pays for a model when two agents touched one file', () => {
    const decision = decideSynthesis({
      authority: authority(), spentUsd: 0, synthesis,
      children: [report('a', enveloped('done a', ['same.ts'])), report('b', enveloped('done b', ['same.ts']))],
    });
    expect(decision.chosen).toBe('SYNTHESIZE');
    expect(decision.reason).toMatch(/changed by more than one agent/);
  });
});

describe('model choice', () => {
  // One source of truth for the money: the gate's `authority` and `spentUsd`.
  // Two fields meaning the same thing is how a guard and a router disagree.
  const KEYS = ['ORG_MODEL_EXECUTE', 'ORG_MODEL_DEEP'];
  afterEach(() => { for (const key of KEYS) delete process.env[key]; });

  it('tiers a trivial job down, on the fast path', () => {
    const decision = decideModel({
      authority: authority(), spentUsd: 0, dispatch,
      role: 'execute', complexity: 'low',
    });
    expect(decision.chosen).toBe('RUN_MODEL');
    expect(decision.fastPath).toBe(true);
  });

  it('reports an escalation as one when an operator configured a deep tier', () => {
    process.env.ORG_MODEL_DEEP = 'opus';
    const decision = decideModel({
      authority: authority(), spentUsd: 0, dispatch,
      role: 'execute', complexity: 'high',
    });
    expect(decision.chosen).toBe('ESCALATE_MODEL');
  });

  it('is stopped by the budget gate like everything else', () => {
    const decision = decideModel({
      authority: authority({ budget_usd: 1 }), spentUsd: 2, dispatch,
      role: 'execute', complexity: 'high',
    });
    expect(decision.chosen).toBe('STOP');
  });
});

describe('receipts', () => {
  it('always name an alternative, unless a hard gate left nothing to compare', () => {
    const gated = hardGates({ authority: authority({ budget_usd: 1 }), spentUsd: 2 })!;
    expect(gated.alternatives).toEqual([]);

    const scored = decideExecutionPath({
      goal: 'g', authority: authority(), spentUsd: 0, complexity: 'medium', worthSplitting: false, dispatch,
    });
    expect(scored.alternatives.length).toBeGreaterThan(0);
  });
});
