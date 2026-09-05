import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { insertApproval, getPendingApproval, resolveApproval, listPendingApprovals } from './approvals.js';

const TEST_DB = './test-approvals.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

describe('approval queries', () => {
  it('inserts a pending approval and retrieves it by node id', () => {
    const db = createDb(TEST_DB);
    insertApproval(db, { id: 'a1', nodeId: 'n1', reason: 'insufficient budget', status: 'pending', createdAt: 't0' });
    expect(getPendingApproval(db, 'n1')?.id).toBe('a1');
  });

  it('returns undefined once resolved', () => {
    const db = createDb(TEST_DB);
    insertApproval(db, { id: 'a1', nodeId: 'n1', reason: 'x', status: 'pending', createdAt: 't0' });
    resolveApproval(db, 'a1', 'approved', 't1');
    expect(getPendingApproval(db, 'n1')).toBeUndefined();
  });

  it('lists all pending approvals across every node', () => {
    const db = createDb(TEST_DB);
    insertApproval(db, { id: 'a1', nodeId: 'n1', reason: 'x', status: 'pending', createdAt: 't0' });
    insertApproval(db, { id: 'a2', nodeId: 'n2', reason: 'y', status: 'pending', createdAt: 't0' });
    insertApproval(db, { id: 'a3', nodeId: 'n3', reason: 'z', status: 'approved', createdAt: 't0', resolvedAt: 't1' });
    const pending = listPendingApprovals(db);
    expect(pending).toHaveLength(2);
    expect(pending.map((a) => a.id).sort()).toEqual(['a1', 'a2']);
  });
});
