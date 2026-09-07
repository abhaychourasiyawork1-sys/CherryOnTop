import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { insertNode } from './nodes.js';
import { appendEvent } from './events.js';
import { insertApproval } from './approvals.js';
import { getOrgStats, getCostForNodes, getSubtreeCosts, budgetHealth } from './stats.js';

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
    insertApproval(db, { id: 'a1', nodeId: 'n3', reason: 'budget', status: 'pending', createdAt: 't0' });
    insertApproval(db, { id: 'a2', nodeId: 'n1', reason: 'budget', status: 'approved', createdAt: 't0' });

    insertNode(db, { id: 'n4', parentId: null, goal: 'x', contract: CONTRACT, state: 'CANCELLED', repoPath: null, createdAt: 't0', updatedAt: 't0' });

    const stats = getOrgStats(db);
    expect(stats.complete).toBe(1);
    expect(stats.failed).toBe(1);
    // A cancelled node is finished, not running — deriving active by
    // subtraction previously counted it as still working.
    expect(stats.cancelled).toBe(1);
    expect(stats.active).toBe(1);
    expect(stats.totalCostUsd).toBeCloseTo(0.07, 5);
    // Only the still-pending one counts — the status line reports what is
    // blocked on the user right now, not everything ever escalated.
    expect(stats.pendingApprovals).toBe(1);
  });
});

describe('per-node cost', () => {
  const budget = (usd: number) => ({ ...CONTRACT, authority: { ...CONTRACT.authority, budget_usd: usd } });
  const add = (db: ReturnType<typeof createDb>, id: string, parentId: string | null, budgetUsd = 0) =>
    insertNode(db, { id, parentId, goal: id, contract: budget(budgetUsd), state: 'COMPLETE', repoPath: null, createdAt: 't0', updatedAt: 't0' });

  it('sums only result events, only for the nodes asked about', () => {
    const db = createDb(TEST_DB);
    add(db, 'n1', null);
    appendEvent(db, { nodeId: 'n1', type: 'exec.result', payload: { total_cost_usd: 0.05 }, createdAt: 't0' });
    appendEvent(db, { nodeId: 'n1', type: 'exec.result', payload: { total_cost_usd: 0.01 }, createdAt: 't0' });
    appendEvent(db, { nodeId: 'n1', type: 'exec.assistant', payload: { total_cost_usd: 99 }, createdAt: 't0' });
    appendEvent(db, { nodeId: 'n2', type: 'exec.result', payload: { total_cost_usd: 5 }, createdAt: 't0' });

    expect(getCostForNodes(db, ['n1'])).toBeCloseTo(0.06, 5);
    expect(getCostForNodes(db, [])).toBe(0);
  });

  it('rolls a child’s spend up into every ancestor', () => {
    const db = createDb(TEST_DB);
    add(db, 'root', null, 5);
    add(db, 'a', 'root', 1);
    add(db, 'a1', 'a', 1);
    appendEvent(db, { nodeId: 'a1', type: 'exec.result', payload: { total_cost_usd: 0.4 }, createdAt: 't0' });
    appendEvent(db, { nodeId: 'root', type: 'exec.result', payload: { total_cost_usd: 0.1 }, createdAt: 't0' });

    const costs = getSubtreeCosts(db);
    expect(costs.get('a1')).toBeCloseTo(0.4, 5);
    expect(costs.get('a')).toBeCloseTo(0.4, 5);
    // A parent that delegated is still accountable for what its subtree spent.
    expect(costs.get('root')).toBeCloseTo(0.5, 5);
  });

  it('reports budget health, including overspend, and never divides by zero', () => {
    expect(budgetHealth(0.5, 2)).toBeCloseTo(0.25, 5);
    expect(budgetHealth(3, 2)).toBeCloseTo(1.5, 5);
    expect(budgetHealth(1, 0)).toBe(0);
  });
});
