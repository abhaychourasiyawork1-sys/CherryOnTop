import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { buildServer } from '../app.js';
import { createDb } from '../../db/client.js';
import { insertNode } from '../../db/queries/nodes.js';
import { insertApproval } from '../../db/queries/approvals.js';
import { insertDecision } from '../../db/queries/decisions.js';

const TEST_DB = './test-approval-router.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const contract = (budget: number, tools: string[] = []) => ({
  goal: 'g', definition_of_done: ['d'],
  authority: { tools, spawn_children: false, max_child_count: 0, budget_usd: budget },
  constraints: [],
});

describe('approval router — listPending', () => {
  it('returns an empty array when nothing is pending', async () => {
    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'GET', url: '/trpc/approval.listPending' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data).toEqual([]);
  });

  it('lists seeded pending approvals', async () => {
    const db = createDb(TEST_DB);
    insertNode(db, { id: 'n1', parentId: null, goal: 'g', contract: contract(5), state: 'COMPLETE', repoPath: null, createdAt: 't0', updatedAt: 't0' });
    insertApproval(db, { id: 'a1', nodeId: 'n1', reason: 'over budget', status: 'pending', createdAt: 't0' });

    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'GET', url: '/trpc/approval.listPending' });
    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body).result.data;
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('a1');
  });
});

describe('approval router — get', () => {
  it('returns the approval, its node, the triggering decision, and computed spend', async () => {
    const db = createDb(TEST_DB);
    insertNode(db, { id: 'n1', parentId: null, goal: 'g', contract: contract(2, ['Read']), state: 'COMPLETE', repoPath: null, createdAt: 't0', updatedAt: 't0' });
    insertApproval(db, { id: 'a1', nodeId: 'n1', reason: 'needs more budget', status: 'pending', createdAt: 't0' });
    insertDecision(db, {
      id: 'd1', nodeId: 'n1', type: 'execution_decision', outcome: 'ESCALATE',
      breakdown: { requiredBudget: 10, availableBudget: 2, score: 0.9 },
      createdAt: 't0',
    });

    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({ id: 'a1' }));
    const response = await app.inject({ method: 'GET', url: `/trpc/approval.get?input=${input}` });
    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body).result.data;
    expect(data.approval.id).toBe('a1');
    expect(data.node.id).toBe('n1');
    expect(data.trigger.id).toBe('d1');
    expect(data.requestedUsd).toBe(10);
    expect(data.availableUsd).toBe(2);
    expect(data.spentUsd).toBe(0);
  });

  it('falls back to the node contract budget when there is no triggering decision', async () => {
    const db = createDb(TEST_DB);
    insertNode(db, { id: 'n1', parentId: null, goal: 'g', contract: contract(3), state: 'COMPLETE', repoPath: null, createdAt: 't0', updatedAt: 't0' });
    insertApproval(db, { id: 'a1', nodeId: 'n1', reason: 'r', status: 'pending', createdAt: 't0' });

    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({ id: 'a1' }));
    const response = await app.inject({ method: 'GET', url: `/trpc/approval.get?input=${input}` });
    const data = JSON.parse(response.body).result.data;
    expect(data.trigger).toBeNull();
    expect(data.requestedUsd).toBe(0);
    expect(data.availableUsd).toBe(3);
  });

  it('throws (not a 200) for an approval id that does not exist', async () => {
    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({ id: 'does-not-exist' }));
    const response = await app.inject({ method: 'GET', url: `/trpc/approval.get?input=${input}` });
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error.message).toContain('does-not-exist');
  });

  it('rejects a request with no id via the Zod validation path, not a 500', async () => {
    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({}));
    const response = await app.inject({ method: 'GET', url: `/trpc/approval.get?input=${input}` });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.data.code).toBe('BAD_REQUEST');
  });

  // Security boundary: the authority and spend the approval screen renders must
  // be exactly what is stored, never widened past the node's actual contract —
  // a human approving what they see must be approving what is real.
  it('never reports authority or an available budget broader than what the node contract actually stores', async () => {
    const db = createDb(TEST_DB);
    insertNode(db, { id: 'n1', parentId: null, goal: 'g', contract: contract(2, ['Read']), state: 'COMPLETE', repoPath: null, createdAt: 't0', updatedAt: 't0' });
    insertApproval(db, { id: 'a1', nodeId: 'n1', reason: 'r', status: 'pending', createdAt: 't0' });

    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({ id: 'a1' }));
    const response = await app.inject({ method: 'GET', url: `/trpc/approval.get?input=${input}` });
    const data = JSON.parse(response.body).result.data;
    expect(data.node.contract.authority.budget_usd).toBe(2);
    expect(data.node.contract.authority.tools).toEqual(['Read']);
    expect(data.node.contract.authority.spawn_children).toBe(false);
    expect(data.availableUsd).toBeLessThanOrEqual(2);
  });
});
