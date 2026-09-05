import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { insertNode, getNode, updateNodeState, listNodes } from './nodes.js';

const TEST_DB = './test-nodes.db';

function cleanUp() {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
}

afterEach(cleanUp);

const CONTRACT = {
  goal: 'test',
  definition_of_done: ['done'],
  authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 0 },
  constraints: [],
};

describe('node queries', () => {
  it('inserts and retrieves a node', () => {
    const db = createDb(TEST_DB);
    insertNode(db, {
      id: 'n1', parentId: null, goal: 'test', contract: CONTRACT,
      state: 'CREATED', createdAt: 't0', updatedAt: 't0',
    });
    const node = getNode(db, 'n1');
    expect(node?.goal).toBe('test');
    expect(node?.state).toBe('CREATED');
  });

  it('updates node state', () => {
    const db = createDb(TEST_DB);
    insertNode(db, {
      id: 'n1', parentId: null, goal: 'test', contract: CONTRACT,
      state: 'CREATED', createdAt: 't0', updatedAt: 't0',
    });
    updateNodeState(db, 'n1', 'ORIENT', 't1');
    const node = getNode(db, 'n1');
    expect(node?.state).toBe('ORIENT');
    expect(node?.updatedAt).toBe('t1');
  });

  it('lists all nodes', () => {
    const db = createDb(TEST_DB);
    insertNode(db, { id: 'n1', parentId: null, goal: 'a', contract: CONTRACT, state: 'CREATED', createdAt: 't0', updatedAt: 't0' });
    insertNode(db, { id: 'n2', parentId: 'n1', goal: 'b', contract: CONTRACT, state: 'CREATED', createdAt: 't0', updatedAt: 't0' });
    expect(listNodes(db)).toHaveLength(2);
  });

  it('stores and retrieves an optional repoPath', () => {
    const db = createDb(TEST_DB);
    insertNode(db, { id: 'n1', parentId: null, goal: 'test', contract: CONTRACT, state: 'CREATED', createdAt: 't0', updatedAt: 't0', repoPath: '/host/my-repo' });
    expect(getNode(db, 'n1')?.repoPath).toBe('/host/my-repo');
  });

  it('defaults repoPath to null when not given', () => {
    const db = createDb(TEST_DB);
    insertNode(db, { id: 'n2', parentId: null, goal: 'test', contract: CONTRACT, state: 'CREATED', createdAt: 't0', updatedAt: 't0', repoPath: null });
    expect(getNode(db, 'n2')?.repoPath).toBeNull();
  });

  it('returns undefined for a missing node', () => {
    const db = createDb(TEST_DB);
    expect(getNode(db, 'missing')).toBeUndefined();
  });
});
