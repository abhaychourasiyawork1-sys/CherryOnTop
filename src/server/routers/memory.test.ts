import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { buildServer } from '../app.js';
import { createDb } from '../../db/client.js';
import { insertNode } from '../../db/queries/nodes.js';
import { recordRunOutcome } from '../../db/queries/memory.js';
import { recordDispatchUsage } from '../../db/queries/tokens.js';

const TEST_DB = './test-memory-router.db';
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

const outcome = (overrides: Partial<{ succeeded: boolean; costUsd: number; latencyMs: number }> = {}) => ({
  runtime: 'claude-code', succeeded: true, costUsd: 0.5, latencyMs: 100,
  complexity: 'low' as const, delegated: false, ...overrides,
});

describe('memory router — runtimeStats', () => {
  it('returns an empty array when nothing has run yet', async () => {
    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'GET', url: '/trpc/memory.runtimeStats' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data).toEqual([]);
  });

  it('aggregates seeded run outcomes by runtime', async () => {
    const db = createDb(TEST_DB);
    recordRunOutcome(db, { id: 'r1', nodeId: 'n1', outcome: outcome({ succeeded: true, costUsd: 1 }), createdAt: 't0' });
    recordRunOutcome(db, { id: 'r2', nodeId: 'n1', outcome: outcome({ succeeded: false, costUsd: 3 }), createdAt: 't0' });

    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'GET', url: '/trpc/memory.runtimeStats' });
    const data = JSON.parse(response.body).result.data;
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ runtime: 'claude-code', runs: 2, successRate: 0.5, avgCostUsd: 2 });
  });
});

describe('memory router — claims', () => {
  it('returns an empty array when there are no runtimes to report on', async () => {
    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'GET', url: '/trpc/memory.claims' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data).toEqual([]);
  });

  it('attaches the evidence behind each aggregate, and excludes vetoed rows separately', async () => {
    const db = createDb(TEST_DB);
    insertNode(db, { id: 'n1', parentId: null, goal: 'the goal', contract, state: 'COMPLETE', repoPath: null, createdAt: 't0', updatedAt: 't0' });
    recordRunOutcome(db, { id: 'r1', nodeId: 'n1', outcome: outcome(), createdAt: 't0' });

    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'GET', url: '/trpc/memory.claims' });
    const data = JSON.parse(response.body).result.data;
    expect(data).toHaveLength(1);
    expect(data[0].basis).toHaveLength(1);
    expect(data[0].basis[0]).toMatchObject({ id: 'r1', nodeId: 'n1', goal: 'the goal' });
    expect(data[0].excluded).toEqual([]);
  });
});

describe('memory router — veto', () => {
  it('excludes an observation from the aggregate it used to count in', async () => {
    const db = createDb(TEST_DB);
    recordRunOutcome(db, { id: 'r1', nodeId: 'n1', outcome: outcome(), createdAt: 't0' });

    const app = buildServer(TEST_DB, () => {});
    const vetoResponse = await app.inject({ method: 'POST', url: '/trpc/memory.veto', payload: { id: 'r1', vetoed: true } });
    expect(vetoResponse.statusCode).toBe(200);
    expect(JSON.parse(vetoResponse.body).result.data).toEqual({ ok: true });

    const statsResponse = await app.inject({ method: 'GET', url: '/trpc/memory.runtimeStats' });
    expect(JSON.parse(statsResponse.body).result.data).toEqual([]);

    const claimsResponse = await app.inject({ method: 'GET', url: '/trpc/memory.claims' });
    expect(JSON.parse(claimsResponse.body).result.data).toEqual([]);
  });

  it('rejects a request missing the required fields via the Zod validation path, not a 500', async () => {
    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'POST', url: '/trpc/memory.veto', payload: { id: 'r1' } });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.data.code).toBe('BAD_REQUEST');
  });
});

describe('memory router — recent', () => {
  it('returns an empty array when there is no memory yet', async () => {
    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({}));
    const response = await app.inject({ method: 'GET', url: `/trpc/memory.recent?input=${input}` });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data).toEqual([]);
  });

  it('returns seeded rows newest first, filtered by kind', async () => {
    const db = createDb(TEST_DB);
    recordRunOutcome(db, { id: 'r1', nodeId: 'n1', outcome: outcome(), createdAt: 't0' });
    recordRunOutcome(db, { id: 'r2', nodeId: 'n1', outcome: outcome(), createdAt: 't1' });

    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({ kind: 'run_outcome' }));
    const response = await app.inject({ method: 'GET', url: `/trpc/memory.recent?input=${input}` });
    const data = JSON.parse(response.body).result.data;
    expect(data.map((r: { id: string }) => r.id)).toEqual(['r2', 'r1']);
  });

  it('rejects a limit above the allowed maximum via the Zod validation path, not a 500', async () => {
    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({ limit: 5000 }));
    const response = await app.inject({ method: 'GET', url: `/trpc/memory.recent?input=${input}` });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.data.code).toBe('BAD_REQUEST');
  });
});

describe('memory router — tokens', () => {
  it('returns empty rows and zero cache-hit counts with no usage recorded', async () => {
    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'GET', url: '/trpc/memory.tokens' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data).toEqual({ rows: [], planCacheHits: 0, resultCacheHits: 0 });
  });

  it('aggregates seeded dispatch usage by role and model', async () => {
    const db = createDb(TEST_DB);
    recordDispatchUsage(db, {
      nodeId: 'n1', role: 'execute', model: 'claude', costUsd: 0.2, createdAt: 't0',
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 },
    });

    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'GET', url: '/trpc/memory.tokens' });
    const data = JSON.parse(response.body).result.data;
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({ role: 'execute', model: 'claude', dispatches: 1, inputTokens: 100 });
  });

  it('rejects a non-string caseId via the Zod validation path, not a 500', async () => {
    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({ caseId: 123 }));
    const response = await app.inject({ method: 'GET', url: `/trpc/memory.tokens?input=${input}` });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.data.code).toBe('BAD_REQUEST');
  });
});
