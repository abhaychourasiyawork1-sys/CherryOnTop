/** The runtime's one path from candidates to a committed dispatch, against a
 *  real database: capability discovery, feasibility, the market, the
 *  commitment, settlement, and the learning loop that closes it. */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createDb } from '../db/client.js';
import { insertNode } from '../db/queries/nodes.js';
import { listEventsForNode } from '../db/queries/events.js';
import { listMemory } from '../db/queries/memory.js';
import { memory } from '../db/schema.js';
import { resultCacheKey } from '../db/queries/result-cache.js';
import { claudeCodeAdapter } from '../adapters/claude-code.js';
import { codexAdapter } from '../adapters/codex.js';
import {
  selectExecution, settleExecution, refuseCandidate, refuseModel, recordCandidateOutcomes, forgetExecutionNode,
  observeHarnessHealth, refineDifficulty, withLearningValue, capabilitiesOf, CANDIDATE_OUTCOME_KIND,
  measuredDispatchTokens, costCalibration,
} from './execution-market.js';
import { generateExecutionCandidates, executionEstimate } from '../intelligence/model-router.js';
import { initialEconomicState } from '../decision/state.js';
import { recordDispatchUsage } from '../db/queries/tokens.js';
import { MIN_SAMPLES } from '../efficiency/execution-cost-model.js';
import { difficultyFrom, withObservedFailures } from '../intelligence/difficulty.js';
import { createSystem1 } from '../system1/guard.js';
import { fakeLaya } from '../system1/fake-provider.js';
import { candidateFingerprint, clearPredictionCache } from '../decision/transition.js';
import { actionCandidate } from '../decision/actions.js';
import { modelCapabilities, currentAccount, ALL_MODELS } from '../execution/model-capability.js';

const TEST_DB = './test-execution-market.db';
const GOAL = 'Fix the off-by-one in src/cart/checkout.ts';
const adapters = [claudeCodeAdapter, codexAdapter];

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
  observeHarnessHealth('claude-code', 'healthy');
  observeHarnessHealth('codex', 'healthy');
  clearPredictionCache();
  modelCapabilities.clear();
});

function node(db: ReturnType<typeof createDb>, budgetUsd = 10): string {
  const id = randomUUID();
  insertNode(db, {
    id, parentId: null, goal: GOAL, repoPath: null, state: 'CREATED', createdAt: 't0', updatedAt: 't0',
    contract: {
      goal: GOAL, definition_of_done: [],
      authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: budgetUsd },
      constraints: [],
    },
  });
  return id;
}

/** What the fleet has already learned: haiku does easy work and fails hard
 *  work; opus passes the hardest. Recorded the way `recordCandidateOutcomes`
 *  records it, so the market fits capability from it and nothing else. */
function seedHistory(db: ReturnType<typeof createDb>): void {
  const row = (model: string, difficulty: number, validated: boolean) => ({
    candidateId: `seed|${model}|${difficulty}`, task: [{ level: 'GLOBAL', value: 'all' }], stateSignature: 's',
    predicted: { costUsd: 0.1, latencyMs: 1, successProbability: 0.5, progress: 1 },
    actual: { costUsd: 0.1, latencyMs: 1, succeeded: validated, validated, progress: 1, tokens: 1 },
    recoveryCount: 0, validationLevel: 'V2', validationStrength: 0.85, validity: 'VALID',
    difficulty, modelKey: `execute|claude-code|${model}`, candidateKey: `execute|claude-code|${model}|high`, facts: {},
  });
  const rows = [
    ...Array.from({ length: 10 }, () => row('haiku', 0.2, true)),
    ...Array.from({ length: 10 }, () => row('haiku', 0.8, false)),
    ...Array.from({ length: 10 }, () => row('opus', 0.95, true)),
  ];
  for (const value of rows) {
    db.insert(memory).values({
      id: randomUUID(), kind: CANDIDATE_OUTCOME_KIND, key: value.candidateId, value, confidence: null,
      nodeId: null, createdAt: new Date().toISOString(),
    }).run();
  }
}

describe('one decision, committed and receipted', () => {
  it('chooses a harness and model through the market and reserves for it', () => {
    const db = createDb(TEST_DB);
    const id = node(db);
    const selection = selectExecution(db, { nodeId: id, role: 'execute', goal: GOAL, adapters });
    expect(selection.blocked).toBe(false);
    expect(selection.adapter).not.toBeNull();
    expect(selection.commitment?.reservedResources.tokens).toBeGreaterThan(0);
    const receipt = listEventsForNode(db, id).find((e) => e.type === 'market.decision')!.payload as Record<string, unknown>;
    expect(receipt.chosen).toBe(selection.candidate.id);
    expect(receipt.commitmentId).toBe(selection.commitment?.commitmentId);
    expect((receipt.ranked as unknown[]).length).toBeGreaterThan(0);
    expect(receipt.overhead).toEqual(expect.objectContaining({ candidateCount: expect.any(Number), latencyMs: expect.any(Number) }));
    forgetExecutionNode(id);
  });

  it('turns an outage into infeasibility, not into a different routing mode', () => {
    const db = createDb(TEST_DB);
    const id = node(db);
    observeHarnessHealth('claude-code', 'down');
    const selection = selectExecution(db, { nodeId: id, role: 'execute', goal: GOAL, adapters });
    expect(selection.adapter?.name).toBe('codex');
    expect(selection.decision.reasonCodes.some((c) => c.includes('unavailable:harness_down'))).toBe(true);
    forgetExecutionNode(id);
  });
});

describe('recovery re-enters the same market', () => {
  it('rules out a refused candidate and asks again, rather than retrying a hardcoded default', () => {
    const db = createDb(TEST_DB);
    const id = node(db);
    const first = selectExecution(db, { nodeId: id, role: 'execute', goal: GOAL, adapters });
    settleExecution(db, id, first, { tokens: 10, usd: 0.001, latencyMs: 5, succeeded: false });
    refuseCandidate(id, first.candidate.id, 'model_unavailable_on_plan');

    const second = selectExecution(db, { nodeId: id, role: 'execute', goal: GOAL, adapters });
    expect(second.blocked).toBe(false);
    expect(second.candidate.id).not.toBe(first.candidate.id);
    expect(second.decision.reasonCodes).toContain(`rejected:${first.candidate.id}:unavailable:model_unavailable_on_plan`);
    forgetExecutionNode(id);
  });
});

describe('exact reuse is a candidate, keyed by execution semantics', () => {
  it('lets the market choose a valid cached answer over running anything', () => {
    const db = createDb(TEST_DB);
    const id = node(db);
    const selection = selectExecution(db, {
      nodeId: id, role: 'execute', goal: GOAL, adapters,
      reusable: (candidate) => (candidate.metadata.harness === 'claude-code' ? { candidateId: candidate.id, tokensSaved: 50_000 } : null),
    });
    expect(selection.reuse).not.toBeNull();
    expect(selection.adapter).toBeNull();
    expect(selection.decision.action.id.startsWith('reuse:')).toBe(true);
    forgetExecutionNode(id);
  });

  it('never shares a cache key across materially different candidates', () => {
    const db = createDb(TEST_DB);
    const id = node(db);
    const selection = selectExecution(db, { nodeId: id, role: 'execute', goal: GOAL, adapters });
    const ranked = selection.decision.ranked ?? [];
    const keys = new Set(ranked.map((r) => resultCacheKey(GOAL, r.fingerprint, null)));
    expect(keys.size).toBe(ranked.length);
    expect(resultCacheKey(GOAL, candidateFingerprint(selection.candidate), null))
      .not.toBe(resultCacheKey(GOAL, 'execute|codex|default|default|x', null));
    forgetExecutionNode(id);
  });

  it('prices a mechanical merge against paying for a synthesis', () => {
    const db = createDb(TEST_DB);
    const id = node(db);
    const merge = actionCandidate({ id: 'integrate:merge', kind: 'reuse_evidence', capability: 'integration.mechanical', confidence: 1 });
    const selection = selectExecution(db, { nodeId: id, role: 'synthesize', goal: GOAL, adapters, alternatives: [merge] });
    expect(selection.alternative?.id).toBe('integrate:merge');
    forgetExecutionNode(id);
  });
});

describe('the learning loop closes', () => {
  it('records predicted against actual once validation has ruled, and learns from it', () => {
    const db = createDb(TEST_DB);
    const id = node(db);
    const first = selectExecution(db, { nodeId: id, role: 'execute', goal: GOAL, adapters });
    const predicted = first.decision.expectedCostUsd ?? 0;
    const error = settleExecution(db, id, first, { tokens: 1_000, usd: 5, latencyMs: 100, succeeded: true });
    // Five dollars against a cents-sized prediction: badly under-priced.
    expect(error?.costUsd).toBeGreaterThan(4);
    expect(listEventsForNode(db, id).some((e) => e.type === 'market.settled')).toBe(true);
    expect(recordCandidateOutcomes(db, {
      nodeId: id, goal: GOAL, validated: true, recoveryCount: 0, validationLevel: 'V2',
    })).toBe(1);
    const rows = listMemory(db, CANDIDATE_OUTCOME_KIND);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toEqual(expect.objectContaining({
      candidateId: candidateFingerprint(first.candidate), validity: 'VALID',
      actual: expect.objectContaining({ costUsd: 5, validated: true }),
    }));

    // Seed enough of the same so the evidence carries weight: the next
    // decision for this task shape prices that candidate from what it cost.
    for (let i = 0; i < 20; i++) {
      const other = node(db);
      const s = selectExecution(db, { nodeId: other, role: 'execute', goal: GOAL, adapters });
      if (s.candidate.id !== first.candidate.id) break;
      settleExecution(db, other, s, { tokens: 1_000, usd: 5, latencyMs: 100, succeeded: true });
      recordCandidateOutcomes(db, { nodeId: other, goal: GOAL, validated: true, recoveryCount: 0, validationLevel: 'V2' });
    }
    const later = selectExecution(db, { nodeId: node(db), role: 'execute', goal: GOAL, adapters });
    const priced = (later.decision.ranked ?? []).find((r) => r.fingerprint === candidateFingerprint(first.candidate));
    // Either it now prices at what it really cost, or it has been displaced
    // by something cheaper — both are the loop working.
    if (priced) {
      expect(priced.provenance).toBe('empirical');
      expect(priced.expectedCostUsd).toBeGreaterThan(predicted);
    } else {
      expect(later.candidate.id).not.toBe(first.candidate.id);
    }
  });

  it('keeps an aborted run visible and out of learning', () => {
    const db = createDb(TEST_DB);
    const id = node(db);
    const first = selectExecution(db, { nodeId: id, role: 'execute', goal: GOAL, adapters });
    settleExecution(db, id, first, { tokens: 1_000, usd: 99, latencyMs: 100, succeeded: false });
    recordCandidateOutcomes(db, { nodeId: id, goal: GOAL, validated: false, recoveryCount: 0, validationLevel: 'V0', validity: 'ABORTED' });
    const rows = listMemory(db, CANDIDATE_OUTCOME_KIND);
    expect(rows).toHaveLength(1);
    expect((rows[0].value as { validity: string }).validity).toBe('ABORTED');
    const next = selectExecution(db, { nodeId: node(db), role: 'execute', goal: GOAL, adapters });
    const priced = (next.decision.ranked ?? []).find((r) => r.fingerprint === candidateFingerprint(first.candidate));
    expect(priced?.provenance).not.toBe('empirical');
  });
});

describe('the fixes: nothing blocks, nothing sticks, nothing is refused twice', () => {
  it('finishes on something that fits instead of blocking a task near the end of its budget', () => {
    const db = createDb(TEST_DB);
    const id = node(db, 1);
    // 85% of a one-dollar authority already spent, on dispatches that history
    // shows to be small: enough of them to be evidence (a single dispatch is an
    // anecdote, and is priced from the static prior instead).
    const tiny = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 1 } as never;
    recordDispatchUsage(db, { nodeId: id, role: 'execute', model: null, costUsd: 0.85, createdAt: new Date().toISOString(), usage: tiny });
    for (let i = 0; i < MIN_SAMPLES; i++) {
      recordDispatchUsage(db, { nodeId: id, role: 'execute', model: null, costUsd: 0, createdAt: new Date().toISOString(), usage: tiny });
    }
    const selection = selectExecution(db, { nodeId: id, role: 'execute', goal: GOAL, adapters });
    expect(selection.blocked).toBe(false);
    expect(selection.decision.estimate?.immediateCost.usd).toBeLessThanOrEqual(0.15 + 1e-9);
    forgetExecutionNode(id);
  });

  it('lets a rate limit lapse when its window resets', () => {
    const db = createDb(TEST_DB);
    const id = node(db);
    observeHarnessHealth('claude-code', 'rate_limited', Date.now() - 1);
    const selection = selectExecution(db, { nodeId: id, role: 'execute', goal: GOAL, adapters });
    expect(selection.decision.reasonCodes.some((c) => c.includes('harness_rate_limited'))).toBe(false);
    forgetExecutionNode(id);
  });

  it('keeps a harness infeasible only until the reset it was told', () => {
    const db = createDb(TEST_DB);
    const id = node(db);
    observeHarnessHealth('claude-code', 'rate_limited', Date.now() + 60_000);
    const selection = selectExecution(db, { nodeId: id, role: 'execute', goal: GOAL, adapters });
    expect(selection.adapter?.name).toBe('codex');
    forgetExecutionNode(id);
  });

  it('rules a refused model out at every effort, so the retry is a different model', () => {
    const db = createDb(TEST_DB);
    const id = node(db);
    const first = selectExecution(db, { nodeId: id, role: 'execute', goal: GOAL, adapters });
    refuseModel(id, first.adapter!.name, first.model, 'model_unavailable_on_plan');
    const second = selectExecution(db, { nodeId: id, role: 'execute', goal: GOAL, adapters, harness: first.adapter!.name });
    expect(second.blocked).toBe(false);
    expect(second.model).not.toBe(first.model);
    forgetExecutionNode(id);
  });

  it('escalates to a candidate that has shown it can do harder work after this node has failed', () => {
    const db = createDb(TEST_DB);
    seedHistory(db);
    const known = difficultyFrom(0.2, 20, 'system1');
    const calm = node(db);
    const before = selectExecution(db, { nodeId: calm, role: 'execute', goal: GOAL, adapters, difficulty: known });
    const failing = node(db);
    const escalated = selectExecution(db, {
      nodeId: failing, role: 'execute', goal: GOAL, adapters,
      difficulty: withObservedFailures(known, 0.9),
    });
    // No rule says "escalate on retry": the failure moved the belief about how
    // hard the work is, and what history says haiku and opus can do did the rest.
    expect(before.model).toBe('haiku');
    expect(escalated.model).toBe('opus');
    forgetExecutionNode(calm); forgetExecutionNode(failing);
  });
});

describe('the difficulty question is bought only when it can change the dispatch', () => {
  const s1 = (p: number) => createSystem1(fakeLaya(p), { maxCallsPerScope: 10, timeoutMs: 1_000 });

  it('does not ask while nothing has been learned: no candidate is yet better than another at any difficulty', async () => {
    const db = createDb(TEST_DB);
    const id = node(db);
    const refined = await refineDifficulty(db, { nodeId: id, role: 'execute', goal: GOAL, adapters }, s1(0.9));
    expect(refined.asked).toBe(false);
    expect(refined.valueUsd).toBe(0);
    forgetExecutionNode(id);
  });

  it('does not ask about a task the market would dispatch the same way however hard it is', async () => {
    const db = createDb(TEST_DB);
    const id = node(db);
    process.env.ORG_MODEL_EXECUTE = 'sonnet';
    try {
      const refined = await refineDifficulty(db, { nodeId: id, role: 'execute', goal: GOAL, adapters: [claudeCodeAdapter] }, s1(0.9));
      expect(refined.asked).toBe(false);
      expect(refined.valueUsd).toBe(0);
    } finally {
      delete process.env.ORG_MODEL_EXECUTE;
      forgetExecutionNode(id);
    }
  });

  it('asks when the answer could change the choice and is worth more than the question', async () => {
    const db = createDb(TEST_DB);
    seedHistory(db);
    const id = node(db);
    const vague = 'Refactor the payment module across all services to use the new ledger API and add tests';
    const refined = await refineDifficulty(db, { nodeId: id, role: 'execute', goal: vague, adapters }, s1(0.9), 0);
    expect(refined.valueUsd).toBeGreaterThan(0);
    expect(refined.asked).toBe(true);
    expect(refined.difficulty.sources).toContain('system1');
    forgetExecutionNode(id);
  });

  it('does not ask when the question costs more than any answer could save', async () => {
    const db = createDb(TEST_DB);
    seedHistory(db);
    const id = node(db);
    const vague = 'Refactor the payment module across all services to use the new ledger API and add tests';
    const refined = await refineDifficulty(db, { nodeId: id, role: 'execute', goal: vague, adapters }, s1(0.9), 1_000);
    expect(refined.asked).toBe(false);
    forgetExecutionNode(id);
  });
});

describe('information has a price, so a wrong prior cannot lock in', () => {
  const claude = capabilitiesOf(claudeCodeAdapter);
  const state = () => initialEconomicState({ goal: GOAL, totalTokenBudget: 4_000_000 });
  const cands = () => generateExecutionCandidates({ role: 'execute', difficulty: 0.45, harnesses: [claude], dispatchTokens: 40_000, dispatchLatencyMs: 1 });
  const keys = [{ level: 'GLOBAL' as const, value: 'all' }, { level: 'TASK_SHAPE' as const, value: 'bugfix:medium' }];
  const seen = (n: number) => Array.from({ length: n }, (_, i) => ({
    candidateId: `x${i}`, task: keys, stateSignature: 's',
    predicted: { costUsd: 0, latencyMs: 0, successProbability: 0, progress: 1 },
    actual: { costUsd: 0, latencyMs: 0, succeeded: true, validated: true, progress: 1, tokens: 1 },
    recoveryCount: 0, validationLevel: 'V2' as const, validity: 'VALID' as const,
  }));

  it('prices nothing to learn for a task shape never seen before', () => {
    const priced = withLearningValue(cands(), state(), [], keys, new Map());
    expect(priced.every((c) => c.metadata.learningValueUsd === undefined)).toBe(true);
  });

  it('values trying an uncertain candidate more the more often this kind of task recurs', () => {
    const total = (n: number) => withLearningValue(cands(), state(), seen(n), keys, new Map())
      .reduce((sum, c) => sum + ((c.metadata.learningValueUsd as number | undefined) ?? 0), 0);
    expect(total(10)).toBeGreaterThan(0);
    expect(total(50)).toBeGreaterThan(total(10));
  });

  it('never offers a candidate below the quality floor as something worth learning about', () => {
    const priced = withLearningValue(cands(), state(), seen(50), keys, new Map());
    for (const c of priced.filter((x) => ((x.metadata.learningValueUsd as number | undefined) ?? 0) > 0)) {
      expect(executionEstimate(c, state()).bounds.successLowerBound).toBeGreaterThanOrEqual(state().constraints.qualityFloor);
    }
  });
});


describe('what the fleet already learned about a model, before another sandbox is spent finding out', () => {
  const blockOn = (provider: string, model: string, failure: 'model_unavailable' | 'auth' = 'model_unavailable') =>
    modelCapabilities.observeFailure({ provider, model, account: currentAccount() }, failure);

  it('rules a model out for a different node once any node has been refused it', () => {
    const db = createDb(TEST_DB);
    const first = node(db);
    const chosen = selectExecution(db, { nodeId: first, role: 'execute', goal: GOAL, adapters });
    blockOn(chosen.adapter!.name, chosen.model!);

    const other = node(db);
    const next = selectExecution(db, { nodeId: other, role: 'execute', goal: GOAL, adapters, harness: chosen.adapter!.name });
    expect(next.blocked).toBe(false);
    expect(next.model).not.toBe(chosen.model);
    // The rejection is on the record, with its reason, on the market decision.
    const reasons = (next.decision.rejected ?? []).flatMap((r) => r.reasonCodes);
    expect(reasons.some((c) => c.includes('model_capability_cooldown'))).toBe(true);
    forgetExecutionNode(first); forgetExecutionNode(other);
  });

  it('brings the model back the moment it works, without waiting out the cooldown', () => {
    const db = createDb(TEST_DB);
    const first = node(db);
    const chosen = selectExecution(db, { nodeId: first, role: 'execute', goal: GOAL, adapters });
    blockOn(chosen.adapter!.name, chosen.model!);
    modelCapabilities.observeSuccess({ provider: chosen.adapter!.name, model: chosen.model!, account: currentAccount() });
    const again = selectExecution(db, { nodeId: node(db), role: 'execute', goal: GOAL, adapters });
    expect(again.model).toBe(chosen.model);
    forgetExecutionNode(first);
  });

  it('never lets a cached belief empty the market: with everything in cooldown it is set aside', () => {
    const db = createDb(TEST_DB);
    for (const a of adapters) blockOn(a.name, ALL_MODELS, 'auth');
    const id = node(db);
    const selection = selectExecution(db, { nodeId: id, role: 'execute', goal: GOAL, adapters });
    // The runtime, not a stale cooldown, gets to say no: the dispatch still has
    // a candidate, and its own model-fallback path handles a real refusal.
    expect(selection.blocked).toBe(false);
    expect(selection.adapter).toBeDefined();
    forgetExecutionNode(id);
  });

  it('does not touch a model on another account', () => {
    const db = createDb(TEST_DB);
    const first = node(db);
    const chosen = selectExecution(db, { nodeId: first, role: 'execute', goal: GOAL, adapters });
    modelCapabilities.observeFailure({ provider: chosen.adapter!.name, model: chosen.model!, account: 'some-other-account' }, 'model_unavailable');
    const again = selectExecution(db, { nodeId: node(db), role: 'execute', goal: GOAL, adapters });
    expect(again.model).toBe(chosen.model);
    forgetExecutionNode(first);
  });
});


describe('pricing a dispatch from what similar ones cost', () => {
  const usage = (tokens: number) => ({ inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 1 });
  const record = (db: ReturnType<typeof createDb>, model: string | null, tokens: number, extra: { effort?: string; taskClass?: string } = {}) =>
    recordDispatchUsage(db, { nodeId: 'n', role: 'execute', model, usage: usage(tokens), costUsd: 0, createdAt: 't', ...extra });

  it('keeps the static prior until there is enough history to be evidence', () => {
    const db = createDb(TEST_DB);
    const prior = measuredDispatchTokens(db, 'execute');
    for (let i = 0; i < MIN_SAMPLES - 1; i++) record(db, 'sonnet', 900_000);
    expect(measuredDispatchTokens(db, 'execute')).toBe(prior);
    record(db, 'sonnet', 900_000);
    expect(measuredDispatchTokens(db, 'execute')).toBe(900_000);
  });

  it('prices a candidate from the tail of its own history, not from the cheap median alone', () => {
    const db = createDb(TEST_DB);
    // Every model: usually 40k, sometimes 400k.
    const history = [40_000, 40_000, 40_000, 40_000, 40_000, 40_000, 40_000, 40_000, 400_000, 400_000];
    for (const model of ['sonnet', 'haiku', 'opus', null]) for (const t of history) record(db, model, t);
    const id = node(db);
    const selection = selectExecution(db, { nodeId: id, role: 'execute', goal: GOAL, adapters: [claudeCodeAdapter] });
    const q = selection.candidate.metadata.costQuantiles as { p50: number; p90: number; lambda: number };
    expect(q.p90).toBeGreaterThan(q.p50 * 5);
    // Priced between the median and the tail at the task's own risk aversion.
    expect(selection.candidate.tokenCost).toBeGreaterThan(q.p50);
    expect(selection.candidate.tokenCost).toBe(Math.round(q.p50 + q.lambda * (q.p90 - q.p50)));
    forgetExecutionNode(id);
  });

  it('records the distribution a candidate was priced from, and the calibration of it afterwards', () => {
    const db = createDb(TEST_DB);
    for (let i = 0; i < 12; i++) { record(db, 'sonnet', 50_000 + i * 1_000); record(db, 'haiku', 20_000 + i * 500); record(db, null, 30_000); }
    const id = node(db);
    const selection = selectExecution(db, { nodeId: id, role: 'execute', goal: GOAL, adapters: [claudeCodeAdapter] });
    const q = selection.candidate.metadata.costQuantiles as { p50: number; p90: number; sampleCount: number; segment: string; lambda: number };
    expect(q).toBeDefined();
    expect(q.sampleCount).toBeGreaterThanOrEqual(MIN_SAMPLES);
    expect(q.p90).toBeGreaterThanOrEqual(q.p50);
    expect(q.lambda).toBeGreaterThanOrEqual(0);

    settleExecution(db, id, selection, { tokens: Math.round(q.p50), usd: 0.1, latencyMs: 1_000, succeeded: true });
    const calibration = costCalibration(db);
    expect(calibration.n).toBe(1);
    expect(calibration.p50).toBe(1);
    forgetExecutionNode(id);
  });

  it('reads a fresh database as calibrated on nothing rather than failing', () => {
    expect(costCalibration(createDb(TEST_DB))).toMatchObject({ n: 0 });
  });
});
