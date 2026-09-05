import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { insertNode } from './nodes.js';
import { appendEvent } from './events.js';
import { getOrgStats } from './stats.js';

const TEST_DB = './test-stats.db';
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

describe('getOrgStats', () => {
  it('counts nodes by state and sums real cost from result events', () => {
    const db = createDb(TEST_DB);
    insertNode(db, { id: 'n1', parentId: null, goal: 'x', contract: CONTRACT, state: 'COMPLETE', repoPath: null, createdAt: 't0', updatedAt: 't0' });
    insertNode(db, { id: 'n2', parentId: null, goal: 'x', contract: CONTRACT, state: 'FAILED', repoPath: null, createdAt: 't0', updatedAt: 't0' });
    insertNode(db, { id: 'n3', parentId: null, goal: 'x', contract: CONTRACT, state: 'EXECUTION_DECISION', repoPath: null, createdAt: 't0', updatedAt: 't0' });
    appendEvent(db, { nodeId: 'n1', type: 'exec.result', payload: { type: 'result', total_cost_usd: 0.05 }, createdAt: 't0' });
    appendEvent(db, { nodeId: 'n2', type: 'exec.result', payload: { type: 'result', total_cost_usd: 0.02 }, createdAt: 't0' });
    // Not a cost event — must not be counted.
    appendEvent(db, { nodeId: 'n3', type: 'state.transition', payload: { state: 'ORIENT' }, createdAt: 't0' });

    const stats = getOrgStats(db);
    expect(stats.complete).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.active).toBe(1);
    expect(stats.totalCostUsd).toBeCloseTo(0.07, 5);
  });
});
