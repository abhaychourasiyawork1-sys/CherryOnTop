import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { buildServer } from '../app.js';
import { createDb } from '../../db/client.js';
import { insertNode } from '../../db/queries/nodes.js';
import { appendEvent } from '../../db/queries/events.js';
import { insertApproval } from '../../db/queries/approvals.js';

const TEST_DB = './test-daemon-router.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const contract = {
  goal: 'g', definition_of_done: ['d'],
  authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 1 },
  constraints: [],
};

describe('daemon router — ping', () => {
  it('reports the routers this daemon serves', async () => {
    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'GET', url: '/trpc/daemon.ping' });
    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body).result.data;
    expect(data.ok).toBe(true);
    expect(typeof data.pid).toBe('number');
    expect(data.routers).toEqual(expect.arrayContaining(['daemon', 'node', 'approval', 'mandate']));
  });
});

describe('daemon router — stats', () => {
  it('reports zero counts against an empty database', async () => {
    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'GET', url: '/trpc/daemon.stats' });
    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body).result.data;
    expect(data).toEqual({ active: 0, complete: 0, failed: 0, cancelled: 0, totalCostUsd: 0, pendingApprovals: 0 });
  });

  it('rolls up seeded nodes, spend and pending approvals', async () => {
    const db = createDb(TEST_DB);
    insertNode(db, { id: 'n1', parentId: null, goal: 'g', contract, state: 'COMPLETE', repoPath: null, createdAt: 't0', updatedAt: 't0' });
    insertNode(db, { id: 'n2', parentId: null, goal: 'g', contract, state: 'FAILED', repoPath: null, createdAt: 't0', updatedAt: 't0' });
    appendEvent(db, { nodeId: 'n1', type: 'exec.result', payload: { total_cost_usd: 1.5 }, createdAt: 't0' });
    insertApproval(db, { id: 'a1', nodeId: 'n1', reason: 'r', status: 'pending', createdAt: 't0' });

    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'GET', url: '/trpc/daemon.stats' });
    const data = JSON.parse(response.body).result.data;
    expect(data.complete).toBe(1);
    expect(data.failed).toBe(1);
    expect(data.totalCostUsd).toBe(1.5);
    expect(data.pendingApprovals).toBe(1);
  });
});

describe('daemon router — sandboxes', () => {
  it('reports the sandbox limiter shape with nothing running', async () => {
    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'GET', url: '/trpc/daemon.sandboxes' });
    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body).result.data;
    expect(data).toEqual({ active: expect.any(Number), queued: expect.any(Number), max: expect.any(Number) });
    expect(data.active).toBeGreaterThanOrEqual(0);
    expect(data.queued).toBeGreaterThanOrEqual(0);
  });
});
