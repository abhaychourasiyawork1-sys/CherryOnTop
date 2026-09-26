/** A finished change that is only missing proof gets asked for proof, not
 *  redone.
 *
 *  SWE-bench requests-1142 (2026-09-25 matrix): every attempt made the right
 *  change and never ran a test, validation rejected it for the missing
 *  observed check, and the runtime re-ran the whole task from a fresh sandbox
 *  — re-reading the codebase each time — four times, then marked a correct fix
 *  FAILED. */
import { describe, it, expect, afterEach, vi, type Mock } from 'vitest';
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
const { startNodeActor } = await import('./node-actor-manager.js');
const { executeStep } = await import('../execution/execute-step.js');
const { ZERO_USAGE } = await import('../execution/tokens.js');
const { replayInto, successfulRunEvents } = await import('./run-fixtures.js');
import type { ExecuteStepInput } from '../execution/execute-step.js';

const stub = executeStep as unknown as Mock;
const TEST_DB = './test-verification-retry.db';
// A change request across more than one module, so validation wants an
// observed check (V2), not just an artifact.
const GOAL = 'requests.get always sends a Content-Length header, which breaks some servers. GET requests should not add Content-Length automatically; update the models and the adapters so they stop doing it.';

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
  vi.clearAllMocks();
});

function repo(): string {
  const path = mkdtempSync(join(tmpdir(), 'verify-retry-'));
  writeFileSync(join(path, 'models.py'), 'x = 1\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '-A'); git('commit', '-qm', 'x');
  return path;
}

const unverified = { succeeded: true, message: 'done', usage: { ...ZERO_USAGE }, events: successfulRunEvents({ editedPath: 'models.py' }) };
const verified = { succeeded: true, message: 'done', usage: { ...ZERO_USAGE }, events: successfulRunEvents({ editedPath: 'models.py', verifyCommand: 'python -m pytest test_requests.py -k content_length' }) };

async function runWith(responses: Array<typeof unverified>): Promise<{ calls: ExecuteStepInput[]; state: string }> {
  const calls: ExecuteStepInput[] = [];
  stub.mockImplementation(async (input: ExecuteStepInput) => {
    calls.push(input);
    return replayInto(input, responses[Math.min(calls.length - 1, responses.length - 1)]);
  });
  const db = createDb(TEST_DB);
  const id = randomUUID();
  insertNode(db, {
    id, parentId: null, goal: GOAL, repoPath: repo(), state: 'CREATED', createdAt: 't0', updatedAt: 't0',
    contract: { goal: GOAL, definition_of_done: [GOAL], authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 0 }, constraints: [] },
  });
  // What node.create does for a real task: the checklist validation gates on.
  insertDodItems(db, id, [GOAL], 't0', () => randomUUID());
  startNodeActor(db, id, GOAL);
  await vi.waitFor(() => expect(getNode(db, id)?.state).toMatch(/COMPLETE|FAILED/), { timeout: 10_000 });
  return { calls, state: getNode(db, id)!.state };
}

describe('a change rejected only for missing proof', () => {
  it('is retried as a short verification pass, not a fresh run of the task', async () => {
    const { calls, state } = await runWith([unverified, verified]);
    expect(calls).toHaveLength(2);
    expect(calls[1].goal).toContain('Your change is already in place');
    expect(calls[1].maxTurns).toBeLessThanOrEqual(15);
    expect(state).toBe('COMPLETE');
  });

  it('stops after one verification pass that still proves nothing', async () => {
    const { calls, state } = await runWith([unverified, unverified, unverified, unverified]);
    expect(calls).toHaveLength(2);
    expect(state).toBe('FAILED');
  });
});

describe('the definition of done after a failed first attempt', () => {
  it('is ruled again on the next attempt instead of staying frozen at the first verdict', async () => {
    // SWE-bench seaborn (opt rep 61): the first attempt's automatic ruling
    // recorded a check time, which the next ruling reads as "a person already
    // ruled", so no later attempt could satisfy the checklist and a correct
    // fix ran 91 turns and was marked FAILED.
    const failed = { succeeded: false, message: 'crashed', usage: { ...ZERO_USAGE }, events: [] as never[] };
    const { calls, state } = await runWith([failed as never, verified]);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(state).toBe('COMPLETE');
  });
});
