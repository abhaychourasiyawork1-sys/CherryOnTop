/** D2 through the real lifecycle (bench/governor/h26/DESIGN.md §2): the
 *  failure the 2026-10-02 Arm B run found — a first dispatch spending the whole
 *  task turn budget, so the retry was hard-stopped before the boundary ran —
 *  cannot happen with the retry reservation on, and nothing changes with it off. */
import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from 'vitest';
import { existsSync, unlinkSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.ANTHROPIC_API_KEY = 'test-key';

vi.mock('../execution/execute-step.js', () => ({ executeStep: vi.fn() }));
vi.mock('../k8s/cleanup.js', () => ({
  deleteNodeNetworkPolicy: vi.fn(async () => {}),
  deleteNodeJobs: vi.fn(async () => {}),
}));

const { createDb } = await import('../db/client.js');
const { insertNode, getNode } = await import('../db/queries/nodes.js');
const { insertDodItems } = await import('../db/queries/dod.js');
const { listEventsForNode } = await import('../db/queries/events.js');
const { startNodeActor } = await import('./node-actor-manager.js');
const { executeStep } = await import('../execution/execute-step.js');
const { ZERO_USAGE } = await import('../execution/tokens.js');
const { replayInto, successfulRunEvents } = await import('./run-fixtures.js');
import type { ExecuteStepInput } from '../execution/execute-step.js';

const stub = executeStep as unknown as Mock;
const TEST_DB = './test-turn-budget-lifecycle.db';
const GOAL = 'requests.get always sends a Content-Length header, which breaks some servers. GET requests should not add Content-Length automatically; update the models and the adapters so they stop doing it.';
const saved = { ...process.env };

beforeEach(() => { process.env.ORG_MAX_TURNS_EXECUTE = '80'; });
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  for (const k of ['ORG_MAX_TURNS_EXECUTE', 'ORG_TURN_RETRY_RESERVATION']) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  vi.clearAllMocks();
});

function repo(): string {
  const path = mkdtempSync(join(tmpdir(), 'turn-budget-'));
  writeFileSync(join(path, 'models.py'), 'x = 1\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '-A'); git('commit', '-qm', 'x');
  return path;
}

/** Every attempt spends its whole turn cap and runs out of turns. */
async function runSpendingEveryTurn(): Promise<{ calls: ExecuteStepInput[]; id: string; db: ReturnType<typeof createDb> }> {
  const calls: ExecuteStepInput[] = [];
  stub.mockImplementation(async (input: ExecuteStepInput) => {
    calls.push(input);
    return replayInto(input, {
      succeeded: false, message: 'error_max_turns',
      // ~6k tokens a turn, the rate the Arm B runs measured.
      usage: { ...ZERO_USAGE, inputTokens: (input.maxTurns ?? 80) * 6_000, numTurns: input.maxTurns ?? 80 },
      events: successfulRunEvents({ editedPath: 'models.py' }),
    });
  });
  const db = createDb(TEST_DB);
  const id = randomUUID();
  insertNode(db, {
    id, parentId: null, goal: GOAL, repoPath: repo(), state: 'CREATED', createdAt: 't0', updatedAt: 't0',
    contract: { goal: GOAL, definition_of_done: [GOAL], authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 0 }, constraints: [] },
  });
  insertDodItems(db, id, [GOAL], 't0', () => randomUUID());
  startNodeActor(db, id, GOAL);
  await vi.waitFor(() => expect(getNode(db, id)?.state).toMatch(/COMPLETE|FAILED/), { timeout: 15_000 });
  return { calls, id, db };
}

describe('D2 in the lifecycle', () => {
  it('off (the default): unchanged — the first dispatch gets the whole budget and leaves no retry', async () => {
    const { calls } = await runSpendingEveryTurn();
    expect(calls[0].maxTurns).toBe(80);
    expect(calls).toHaveLength(1);
  });

  it('on: the first dispatch is capped at T − R, and the retry still runs with the reservation', async () => {
    process.env.ORG_TURN_RETRY_RESERVATION = 'on';
    const { calls, id, db } = await runSpendingEveryTurn();
    expect(calls[0].maxTurns).toBe(60);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // The reservation reaches the retry (its D2 cap is R = 20); the retry may
    // cap itself lower by its own rules (a proof-only pass runs at most
    // PROOF_PASS_TURNS), never higher.
    expect(calls[1].maxTurns).toBeGreaterThan(0);
    expect(calls[1].maxTurns).toBeLessThanOrEqual(20);
    const budget = listEventsForNode(db, id).filter((e) => e.type === 'dispatch.turn_budget').map((e) => e.payload as { dispatchIndex: number; cap: number; T: number; R: number });
    expect(budget[0]).toMatchObject({ dispatchIndex: 1, cap: 60, T: 80, R: 20 });
    expect(budget[1]).toMatchObject({ dispatchIndex: 2, cap: 20 });
    // Never a dispatch beyond T: the task stops once the budget is spent.
    expect(calls.reduce((s, c) => s + (c.maxTurns ?? 0), 0)).toBeLessThanOrEqual(80);
  });
});
