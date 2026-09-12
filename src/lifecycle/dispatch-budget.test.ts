/** A node that has already spent its budget must not be given another sandbox.
 *
 *  `budget_usd` was consulted when *deciding* — the escalation floor in
 *  decide-execution.ts, the pressure threshold in model-router.ts — and never
 *  again once work was under way. So it bounded what the organization would
 *  agree to start, not what it would spend: the one fully measured run spent
 *  $2.65 against a node whose authority said $0. Cost per successful task was a
 *  number the system reported after the fact and could not enforce.
 *
 *  The guard sits at `dispatch()`, the single chokepoint every sandbox in every
 *  role passes through, beside the cancelled-while-queued check — and for the
 *  same reason: it is the last moment before money is spent. */
import { describe, it, expect, afterEach, vi, type Mock } from 'vitest';
import { existsSync, unlinkSync, mkdtempSync } from 'node:fs';
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
const { appendEvent, listEventsForNode } = await import('../db/queries/events.js');
const { startNodeActor } = await import('./node-actor-manager.js');
const { executeStep } = await import('../execution/execute-step.js');
const { ZERO_USAGE } = await import('../execution/tokens.js');

const stub = executeStep as unknown as Mock;
const TEST_DB = './test-dispatch-budget.db';

// One unit of work, so the node goes straight to SELF_EXECUTE and the only
// dispatch it would make is the one under test.
const GOAL = 'Fix the typo in the README';

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
  vi.clearAllMocks();
});

function add(db: ReturnType<typeof createDb>, repoPath: string, budgetUsd: number): string {
  const id = randomUUID();
  insertNode(db, {
    id, parentId: null, goal: GOAL, repoPath, state: 'CREATED',
    createdAt: 't0', updatedAt: 't0',
    contract: {
      goal: GOAL, definition_of_done: ['typo fixed'],
      authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: budgetUsd },
      constraints: [],
    },
  });
  return id;
}

/** Spend, recorded the way a real dispatch records it: the runtime's own final
 *  `result` event, which is the single source `getCostForNodes` reads. */
function spend(db: ReturnType<typeof createDb>, nodeId: string, costUsd: number): void {
  appendEvent(db, {
    nodeId, type: 'exec.result', payload: { total_cost_usd: costUsd },
    createdAt: new Date().toISOString(),
  });
}

const ok = { succeeded: true, message: 'done', events: [], usage: { ...ZERO_USAGE } };

describe('a dispatch for a node that has spent its budget', () => {
  it('never opens a sandbox, and says why', async () => {
    const db = createDb(TEST_DB);
    const repoPath = mkdtempSync(join(tmpdir(), 'dispatch-budget-'));
    stub.mockResolvedValue(ok);

    const id = add(db, repoPath, 1);
    spend(db, id, 1.25);           // already over, before it starts

    startNodeActor(db, id, GOAL);
    await vi.waitFor(() => expect(getNode(db, id)?.state).toMatch(/COMPLETE|FAILED/), { timeout: 10_000 });

    expect(stub).not.toHaveBeenCalled();
    const progress = listEventsForNode(db, id).filter((e) => e.type === 'step.progress');
    expect(JSON.stringify(progress)).toMatch(/budget spent/i);
  });

  it('still runs a node that is inside its budget, and one nobody costed', async () => {
    const db = createDb(TEST_DB);
    const repoPath = mkdtempSync(join(tmpdir(), 'dispatch-budget-'));
    stub.mockResolvedValue(ok);

    const funded = add(db, repoPath, 5);
    spend(db, funded, 1.25);
    // budget_usd 0 means "nobody costed this node", which is not the same as
    // "this node is out of money" — the convention model-router.ts already uses.
    const uncosted = add(db, repoPath, 0);
    spend(db, uncosted, 99);

    startNodeActor(db, funded, GOAL);
    startNodeActor(db, uncosted, GOAL);
    await vi.waitFor(() => expect(stub.mock.calls.length).toBe(2), { timeout: 10_000 });
  });
});
