// D1 (bench/governor/h26/DESIGN.md §2), against the real boundary.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createDb } from '../db/client.js';
import { insertNode } from '../db/queries/nodes.js';
import { appendEvent } from '../db/queries/events.js';
import { recordDispatchUsage } from '../db/queries/tokens.js';
import { evaluateBoundary, forgetNode } from './economic-runtime.js';
import { interventionEligible, observable, recoverEligible, INELIGIBLE_NO_TELEMETRY } from './boundary-eligibility.js';
import { executeDispatchesForNode } from '../db/queries/tokens.js';

const DB = './test-boundary-eligibility.db';
afterEach(() => { for (const s of ['', '-journal', '-wal', '-shm']) if (existsSync(DB + s)) unlinkSync(DB + s); });
const GOAL = 'Fix the failing session test in src/auth/session.ts';

function seed(db: ReturnType<typeof createDb>): string {
  const id = randomUUID();
  insertNode(db, {
    id, parentId: null, goal: GOAL, repoPath: '/tmp', state: 'CREATED', createdAt: 't0', updatedAt: 't0',
    contract: { goal: GOAL, definition_of_done: ['the test passes'], authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 1 }, constraints: [] },
  });
  return id;
}
function failingCall(db: ReturnType<typeof createDb>, nodeId: string): void {
  const id = randomUUID();
  appendEvent(db, { nodeId, type: 'exec.assistant', createdAt: new Date().toISOString(), payload: { message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }] } } });
  appendEvent(db, { nodeId, type: 'exec.user', createdAt: new Date().toISOString(), payload: { message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'error: readStore is not a function', is_error: true }] } } });
}
const completeDispatch = (db: ReturnType<typeof createDb>, nodeId: string) => recordDispatchUsage(db, {
  nodeId, role: 'execute', model: null, costUsd: 0.1, createdAt: 't1',
  usage: { inputTokens: 60_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 8 },
});
const facts = (db: ReturnType<typeof createDb>, id: string, out: ReturnType<typeof evaluateBoundary>, sig: string | null) => ({
  state: out.state, completedDispatches: executeDispatchesForNode(db, id), failureSignature: sig, candidates: out.cycle.candidates,
});

describe('D1: observable is not intervention-eligible', () => {
  it('the first boundary is observable but intervention-ineligible, and says so exactly once', () => {
    const db = createDb(DB);
    const id = seed(db);
    const out = evaluateBoundary(db, { nodeId: id, goal: GOAL }, { experiment: null });
    expect(observable(out.cycle)).toBe(true);
    expect(interventionEligible(out.state)).toBe(false);
    expect(out.decision!.reasonCodes.filter((c) => c === INELIGIBLE_NO_TELEMETRY)).toHaveLength(1);
    // The existing refusal is intact: nothing but continue can be chosen.
    expect(out.decision!.action.kind).toBe('continue');
    forgetNode(id);
  });

  it('the first boundary is never recover-eligible', () => {
    const db = createDb(DB);
    const id = seed(db);
    const out = evaluateBoundary(db, { nodeId: id, goal: GOAL }, { experiment: null });
    expect(recoverEligible(facts(db, id, out, null))).toBe(false);
    forgetNode(id);
  });

  it('a completed, failed dispatch makes the retry boundary recover-eligible', () => {
    const db = createDb(DB);
    const id = seed(db);
    for (let i = 0; i < 8; i++) failingCall(db, id);
    completeDispatch(db, id);
    const out = evaluateBoundary(db, { nodeId: id, goal: GOAL }, { experiment: null });
    expect(interventionEligible(out.state)).toBe(true);
    expect(out.decision!.reasonCodes).not.toContain(INELIGIBLE_NO_TELEMETRY);
    expect(out.cycle.candidates.some((c) => c.id === 'recovery:retry')).toBe(true);
    expect(recoverEligible(facts(db, id, out, 'Bash#npm test#error: readStore is not a function'))).toBe(true);
    forgetNode(id);
  });

  it('failures from a dispatch that has not completed never make recover eligible', () => {
    const db = createDb(DB);
    const id = seed(db);
    for (let i = 0; i < 8; i++) failingCall(db, id);
    // No usage row: the dispatch that produced these failures has not finished.
    const out = evaluateBoundary(db, { nodeId: id, goal: GOAL }, { experiment: null });
    expect(recoverEligible(facts(db, id, out, 'Bash#npm test#error: readStore is not a function'))).toBe(false);
    forgetNode(id);
  });

  it('a repeated evaluation of an ineligible boundary does not duplicate the marker', () => {
    const db = createDb(DB);
    const id = seed(db);
    const a = evaluateBoundary(db, { nodeId: id, goal: GOAL }, { experiment: null });
    const b = evaluateBoundary(db, { nodeId: id, goal: GOAL }, { experiment: null });
    for (const out of [a, b]) if (out.decision) expect(out.decision.reasonCodes.filter((c) => c === INELIGIBLE_NO_TELEMETRY).length).toBeLessThanOrEqual(1);
    forgetNode(id);
  });
});
