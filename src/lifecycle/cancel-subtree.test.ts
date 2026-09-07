import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../db/client.js';
import { insertNode, getNode } from '../db/queries/nodes.js';
import { insertApproval, listPendingApprovals } from '../db/queries/approvals.js';
import { insertCommitment, listCommitmentsForNode } from '../db/queries/commitments.js';
import { listEventsForNode } from '../db/queries/events.js';
import { cancelSubtree } from './node-actor-manager.js';

const TEST_DB = './test-cancel-subtree.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const CONTRACT = {
  goal: 'g', definition_of_done: ['d'],
  authority: { tools: [], spawn_children: true, max_child_count: 3, budget_usd: 5 },
  constraints: [],
};

type Db = ReturnType<typeof createDb>;

function add(db: Db, id: string, parentId: string | null, state: string, snapshot: unknown = null) {
  insertNode(db, {
    id, parentId, goal: id, contract: CONTRACT as never, state,
    repoPath: null, snapshot, createdAt: 't0', updatedAt: 't0',
  });
  insertCommitment(db, {
    id: `c-${id}`, owner: id, goal: id, definition_of_done: ['d'],
    status: 'pending', created_at: 't0', dependencies: [], evidence: [], risks: [],
  }, 't0');
}

describe('stopping a whole task', () => {
  it('stops every agent under the root, however deep', async () => {
    const db = createDb(TEST_DB);
    add(db, 'root', null, 'DELEGATE');
    add(db, 'kid', 'root', 'SELF_EXECUTE');
    add(db, 'grandkid', 'kid', 'SELF_EXECUTE');

    const result = await cancelSubtree(db, 'root');

    expect(result.stopped.sort()).toEqual(['grandkid', 'kid', 'root']);
    for (const id of ['root', 'kid', 'grandkid']) {
      expect(getNode(db, id)?.state).toBe('CANCELLED');
    }
  });

  it('leaves work that already finished exactly as it was', async () => {
    // Stopping a task must not rewrite the record of what it achieved.
    const db = createDb(TEST_DB);
    add(db, 'root', null, 'DELEGATE');
    add(db, 'done', 'root', 'COMPLETE');
    add(db, 'failed', 'root', 'FAILED');

    const result = await cancelSubtree(db, 'root');

    expect(result.stopped).toEqual(['root']);
    expect(getNode(db, 'done')?.state).toBe('COMPLETE');
    expect(getNode(db, 'failed')?.state).toBe('FAILED');
  });

  it('stops an agent a restart had parked, rather than leaving it resumable', async () => {
    // Otherwise the Desk keeps offering Resume for work you just called off.
    const db = createDb(TEST_DB);
    add(db, 'root', null, 'DELEGATE');
    add(db, 'parked', 'root', 'INTERRUPTED', { some: 'snapshot' });

    await cancelSubtree(db, 'root');

    expect(getNode(db, 'parked')?.state).toBe('CANCELLED');
    expect(getNode(db, 'parked')?.snapshot).toBeNull();
  });

  it('closes an approval nobody can answer any more', async () => {
    const db = createDb(TEST_DB);
    add(db, 'root', null, 'WAIT_APPROVAL');
    insertApproval(db, { id: 'a1', nodeId: 'root', reason: 'more budget', status: 'pending', createdAt: 't0' });

    await cancelSubtree(db, 'root');

    expect(listPendingApprovals(db)).toEqual([]);
  });

  it('closes the commitments it can no longer keep', async () => {
    const db = createDb(TEST_DB);
    add(db, 'root', null, 'DELEGATE');
    await cancelSubtree(db, 'root');
    expect(listCommitmentsForNode(db, 'root')[0].status).toBe('cancelled');
  });

  it('records the stop, so the transcript explains the gap', async () => {
    const db = createDb(TEST_DB);
    add(db, 'root', null, 'SELF_EXECUTE');
    await cancelSubtree(db, 'root');
    const transition = listEventsForNode(db, 'root').find((e) => e.type === 'state.transition');
    expect((transition?.payload as { state: string }).state).toBe('CANCELLED');
  });

  it('does not touch another task running alongside it', async () => {
    const db = createDb(TEST_DB);
    add(db, 'root', null, 'DELEGATE');
    add(db, 'kid', 'root', 'SELF_EXECUTE');
    add(db, 'other-root', null, 'DELEGATE');
    add(db, 'other-kid', 'other-root', 'SELF_EXECUTE');

    await cancelSubtree(db, 'root');

    expect(getNode(db, 'other-root')?.state).toBe('DELEGATE');
    expect(getNode(db, 'other-kid')?.state).toBe('SELF_EXECUTE');
  });

  it('is safe to run twice', async () => {
    const db = createDb(TEST_DB);
    add(db, 'root', null, 'DELEGATE');
    await cancelSubtree(db, 'root');
    expect((await cancelSubtree(db, 'root')).stopped).toEqual([]);
  });
});
