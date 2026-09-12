/** A node cancelled while its dispatch sat in the sandbox queue must not then
 *  be given a sandbox.
 *
 *  This is the cheapest bug in the system to reproduce and was the most
 *  expensive to hit. In one measured run, child `1a17107d` waited 4m22s behind
 *  the concurrency limiter, was cancelled at 02:16:34 along with the rest of the
 *  task, and had a brand-new Job created for it at 02:16:36 — two seconds
 *  *after* cancellation, because the limiter handed it a freed slot and nothing
 *  re-checked. It ran 42 turns to completion, finishing 4½ minutes after the
 *  user already had their answer, and spent 9 of that run's 26 percentage points
 *  of the five-hour usage window on output nobody read. `deleteNodeJobs` cannot
 *  prevent this: at cancellation time there is no Job to delete. */
import { describe, it, expect, afterEach, vi, type Mock } from 'vitest';
import { existsSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Before the import below: node-actor-manager builds the shared limiter at
// module scope, so a beforeEach would be too late to make the queue one deep.
process.env.ORG_MAX_CONCURRENT_SANDBOXES = '1';
process.env.ANTHROPIC_API_KEY = 'test-key';

vi.mock('../execution/execute-step.js', () => ({ executeStep: vi.fn() }));
vi.mock('../k8s/cleanup.js', () => ({
  deleteNodeNetworkPolicy: vi.fn(async () => {}),
  deleteNodeJobs: vi.fn(async () => {}),
}));

const { createDb } = await import('../db/client.js');
const { insertNode, getNode } = await import('../db/queries/nodes.js');
const { startNodeActor, cancelSubtree } = await import('./node-actor-manager.js');
const { executeStep } = await import('../execution/execute-step.js');
const { ZERO_USAGE } = await import('../execution/tokens.js');

const stub = executeStep as unknown as Mock;
const TEST_DB = './test-dispatch-cancelled.db';

// Scores as one unit of work, so the node goes straight to SELF_EXECUTE and the
// only dispatch it makes is the one under test.
const GOAL = 'Fix the typo in the README';

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
  vi.clearAllMocks();
});

function add(db: ReturnType<typeof createDb>, repoPath: string): string {
  const id = randomUUID();
  insertNode(db, {
    id, parentId: null, goal: GOAL, repoPath, state: 'CREATED',
    createdAt: 't0', updatedAt: 't0',
    contract: {
      goal: GOAL, definition_of_done: ['typo fixed'],
      // No spawn authority: this test is about the execute dispatch, and a
      // planning dispatch would take the single slot it needs to control.
      authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 5 },
      constraints: [],
    },
  });
  return id;
}

describe('a dispatch whose node was cancelled while queued', () => {
  it('never opens a sandbox for it', async () => {
    const db = createDb(TEST_DB);
    const repoPath = mkdtempSync(join(tmpdir(), 'dispatch-cancelled-'));

    const dispatched: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstIsRunning = new Promise<void>((resolve) => {
      stub.mockImplementation(async (input: { nodeId: string }) => {
        dispatched.push(input.nodeId);
        resolve();
        await new Promise<void>((release) => { releaseFirst = release; });
        return { succeeded: true, message: 'done', events: [], usage: { ...ZERO_USAGE } };
      });
    });

    const holder = add(db, repoPath);
    const queued = add(db, repoPath);

    startNodeActor(db, holder, GOAL);
    await firstIsRunning;              // the one slot is taken
    startNodeActor(db, queued, GOAL);  // ...so this one queues behind it

    // Cancelled while it is still waiting — it has no Job yet, which is exactly
    // why deleting its Jobs achieves nothing.
    await vi.waitFor(() => expect(getNode(db, queued)?.state).toBe('SELF_EXECUTE'));
    expect(dispatched).not.toContain(queued);
    await cancelSubtree(db, queued);

    releaseFirst();
    await vi.waitFor(() => expect(getNode(db, holder)?.state).toBe('COMPLETE'), { timeout: 10_000 });
    // Give the limiter every chance to hand the freed slot on.
    await new Promise((r) => setTimeout(r, 50));

    expect(dispatched).toEqual([holder]);
    expect(getNode(db, queued)?.state).toBe('CANCELLED');
  });
});
