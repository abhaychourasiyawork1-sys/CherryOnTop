import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createActor } from 'xstate';
import { createDb } from '../db/client.js';
import { insertNode, listNodes, getNode } from '../db/queries/nodes.js';
import { insertApproval, listPendingApprovals } from '../db/queries/approvals.js';
import { listEventsForNode } from '../db/queries/events.js';
import { nodeMachine } from './node-machine.js';
import { getNodeActor } from './node-actor-manager.js';
import { recoverNodes, resumeNode, INTERRUPTED } from './rehydrate.js';

const TEST_DB = './test-rehydrate.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const noCluster = { releaseClusterResources: () => {}, releaseJobs: () => {} };

const CONTRACT = {
  goal: 'x', definition_of_done: ['x'],
  authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 1 },
  constraints: [],
};

/** A snapshot as the daemon would have persisted it, parked in `state`. Built
 *  from the real machine so the test proves the real machine can load it back. */
function snapshotAt(state: string, nodeId: string) {
  const resolved = nodeMachine.resolveState({
    value: state,
    context: { nodeId, goal: 'x', lastDecision: { outcome: 'ESCALATE', breakdown: { requiredBudget: 1 } } as never },
  });
  const actor = createActor(nodeMachine, { input: { nodeId, goal: 'x' }, snapshot: resolved });
  return actor.getPersistedSnapshot();
}

function add(db: ReturnType<typeof createDb>, id: string, state: string, snapshot: unknown) {
  insertNode(db, {
    id, parentId: null, goal: id, contract: CONTRACT, state,
    repoPath: null, snapshot, createdAt: 't0', updatedAt: 't0',
  });
}

describe('recovering an organization after a daemon restart', () => {
  it('puts a node parked on a human approval back, so the decision is not lost', () => {
    // This is the case the whole feature exists for: an approval that does not
    // survive a restart is an approval the product cannot be trusted to keep.
    const db = createDb(TEST_DB);
    add(db, 'waiting', 'WAIT_APPROVAL', snapshotAt('WAIT_APPROVAL', 'waiting'));
    insertApproval(db, { id: 'a1', nodeId: 'waiting', reason: 'needs budget', status: 'pending', createdAt: 't0' });

    const summary = recoverNodes(db, 't1', noCluster);

    expect(summary.resumed).toEqual(['waiting']);
    expect(getNodeActor('waiting')).toBeDefined();
    // Still pending, still answerable — the old sweep cancelled it here.
    expect(listPendingApprovals(db).map((a) => a.id)).toEqual(['a1']);
    expect(getNode(db, 'waiting')?.state).toBe('WAIT_APPROVAL');
  });

  it('parks a node that was mid-execution instead of spending money to restart it', () => {
    const db = createDb(TEST_DB);
    add(db, 'running', 'SELF_EXECUTE', snapshotAt('SELF_EXECUTE', 'running'));

    const summary = recoverNodes(db, 't1', noCluster);

    expect(summary.interrupted).toEqual(['running']);
    expect(getNode(db, 'running')?.state).toBe(INTERRUPTED);
    // Its saved state is kept, which is the difference between resumable and dead.
    expect(getNode(db, 'running')?.snapshot).toBeTruthy();
    const events = listEventsForNode(db, 'running');
    expect(events.some((e) => e.type === 'node.interrupted')).toBe(true);
  });

  it('releases the cluster Job of a node it parked', () => {
    const db = createDb(TEST_DB);
    add(db, 'running', 'SELF_EXECUTE', snapshotAt('SELF_EXECUTE', 'running'));
    const released: string[] = [];
    recoverNodes(db, 't1', { ...noCluster, releaseJobs: (id) => { released.push(id); } });
    expect(released).toEqual(['running']);
  });

  it('closes out a node from before snapshots existed, rather than showing it busy for ever', () => {
    const db = createDb(TEST_DB);
    add(db, 'ancient', 'SELF_EXECUTE', null);
    const summary = recoverNodes(db, 't1', noCluster);
    expect(summary.stranded).toEqual(['ancient']);
    expect(getNode(db, 'ancient')?.state).toBe('FAILED');
  });

  it('leaves finished work alone', () => {
    const db = createDb(TEST_DB);
    add(db, 'done', 'COMPLETE', null);
    add(db, 'stopped', 'CANCELLED', null);
    const summary = recoverNodes(db, 't1', noCluster);
    expect(summary).toEqual({ resumed: [], interrupted: [], stranded: [] });
    expect(new Set(listNodes(db).map((n) => n.state))).toEqual(new Set(['COMPLETE', 'CANCELLED']));
  });

  it('does not re-park a node it already parked on an earlier boot', () => {
    const db = createDb(TEST_DB);
    add(db, 'running', 'SELF_EXECUTE', snapshotAt('SELF_EXECUTE', 'running'));
    recoverNodes(db, 't1', noCluster);
    const second = recoverNodes(db, 't2', noCluster);
    expect(second).toEqual({ resumed: [], interrupted: [], stranded: [] });
  });

  it('refuses to resume something that is not interrupted, and says why', () => {
    const db = createDb(TEST_DB);
    add(db, 'done', 'COMPLETE', null);
    expect(() => resumeNode(db, 'done')).toThrow(/nothing to resume/);
  });
});
