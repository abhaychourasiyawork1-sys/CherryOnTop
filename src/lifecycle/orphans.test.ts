import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../db/client.js';
import { insertNode, listNodes } from '../db/queries/nodes.js';
import { insertCommitment, listCommitmentsForNode } from '../db/queries/commitments.js';
import { insertApproval, listPendingApprovals } from '../db/queries/approvals.js';
import { listEventsForNode } from '../db/queries/events.js';
import { strandOrphanedNodes } from './orphans.js';

// Never touch a real cluster from a unit test.
const noCluster = { releaseClusterResources: () => {} };

const TEST_DB = './test-orphans.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const CONTRACT = {
  goal: 'x', definition_of_done: ['x'],
  authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 0 },
  constraints: [],
};

function add(db: ReturnType<typeof createDb>, id: string, state: string) {
  insertNode(db, { id, parentId: null, goal: id, contract: CONTRACT, state, repoPath: null, createdAt: 't0', updatedAt: 't0' });
}

describe('strandOrphanedNodes', () => {
  it('closes every node that was still running, and leaves finished ones alone', () => {
    const db = createDb(TEST_DB);
    add(db, 'running', 'SELF_EXECUTE');
    add(db, 'delegating', 'DELEGATE');
    add(db, 'done', 'COMPLETE');
    add(db, 'failed', 'FAILED');
    add(db, 'stopped', 'CANCELLED');

    expect(strandOrphanedNodes(db, 't1', noCluster).sort()).toEqual(['delegating', 'running']);

    const byId = new Map(listNodes(db).map((n) => [n.id, n.state]));
    expect(byId.get('running')).toBe('FAILED');
    expect(byId.get('delegating')).toBe('FAILED');
    expect(byId.get('done')).toBe('COMPLETE');
    expect(byId.get('failed')).toBe('FAILED');
    expect(byId.get('stopped')).toBe('CANCELLED');
  });

  it('records why, so the transcript explains the gap instead of going silent', () => {
    const db = createDb(TEST_DB);
    add(db, 'running', 'SELF_EXECUTE');
    strandOrphanedNodes(db, 't1', noCluster);

    const events = listEventsForNode(db, 'running');
    const outcome = events.find((e) => e.type === 'step.outcome')!;
    expect((outcome.payload as { message: string }).message).toContain('daemon restarted');
    expect(events.some((e) => e.type === 'state.transition')).toBe(true);
  });

  it('closes the commitment it can no longer keep', () => {
    const db = createDb(TEST_DB);
    add(db, 'running', 'SELF_EXECUTE');
    insertCommitment(db, {
      id: 'c1', owner: 'running', goal: 'g', definition_of_done: ['d'],
      status: 'active', created_at: 't0', dependencies: [], evidence: [], risks: [],
    }, 't0');

    strandOrphanedNodes(db, 't1', noCluster);
    expect(listCommitmentsForNode(db, 'running')[0].status).toBe('failed');
  });

  it('cancels an approval that could never be acted on', () => {
    // Approving a node with no actor fails with "no active actor" — offering it
    // in the inbox is a dead end.
    const db = createDb(TEST_DB);
    add(db, 'waiting', 'WAIT_APPROVAL');
    insertApproval(db, { id: 'a1', nodeId: 'waiting', reason: 'needs budget', status: 'pending', createdAt: 't0' });

    strandOrphanedNodes(db, 't1', noCluster);
    expect(listPendingApprovals(db)).toEqual([]);
  });

  it('does nothing to a clean database', () => {
    expect(strandOrphanedNodes(createDb(TEST_DB), 't1')).toEqual([]);
  });

  it('releases the cluster resources of every node it closes', () => {
    // A stranded node's Job outlives the daemon: one was found stuck in
    // ContainerCreating for 41 minutes, holding a pod nothing would ever read.
    const db = createDb(TEST_DB);
    add(db, 'running', 'SELF_EXECUTE');
    add(db, 'done', 'COMPLETE');
    const released: string[] = [];

    strandOrphanedNodes(db, 't1', { releaseClusterResources: (id) => { released.push(id); } });

    expect(released).toEqual(['running']);
  });
});
