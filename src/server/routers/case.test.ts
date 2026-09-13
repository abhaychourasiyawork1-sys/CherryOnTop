import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { buildServer } from '../app.js';
import { createDb } from '../../db/client.js';
import { insertNode } from '../../db/queries/nodes.js';
import { insertMandate } from '../../db/queries/mandates.js';
import { insertDodItems } from '../../db/queries/dod.js';
import { insertArtifact } from '../../db/queries/artifacts.js';
import { insertApproval } from '../../db/queries/approvals.js';
import { insertDecision } from '../../db/queries/decisions.js';
import { insertCommitment } from '../../db/queries/commitments.js';
import { appendEvent } from '../../db/queries/events.js';

const TEST_DB = './test-case-router.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const contract = (budget = 5) => ({
  goal: 'ship the thing', definition_of_done: ['a check'],
  authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: budget },
  constraints: [],
});

function seedRoot(db: ReturnType<typeof createDb>, id = 'root') {
  insertNode(db, { id, parentId: null, goal: 'ship the thing', contract: contract(), state: 'COMPLETE', repoPath: null, createdAt: 't0', updatedAt: 't0' });
  insertDodItems(db, id, ['a check'], 't0', (i) => `dod-${id}-${i}`);
  insertCommitment(db, { id: `commit-${id}`, owner: id, goal: 'ship the thing', definition_of_done: ['a check'], status: 'pending', created_at: 't0', dependencies: [], evidence: [], risks: [] }, 't0');
}

describe('case router — list', () => {
  it('returns an empty array with no runs yet', async () => {
    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'GET', url: '/trpc/case.list' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data).toEqual([]);
  });

  it('lists a seeded root case', async () => {
    const db = createDb(TEST_DB);
    seedRoot(db);
    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'GET', url: '/trpc/case.list' });
    const data = JSON.parse(response.body).result.data;
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('root');
  });

  it('rejects an unknown outcome value via the Zod validation path, not a 500', async () => {
    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({ outcomes: ['not-a-real-outcome'] }));
    const response = await app.inject({ method: 'GET', url: `/trpc/case.list?input=${input}` });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.data.code).toBe('BAD_REQUEST');
  });
});

describe('case router — facets', () => {
  it('reports no facets with nothing recorded', async () => {
    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'GET', url: '/trpc/case.facets' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data).toEqual({ runtimes: [], repoPaths: [], mandates: [] });
  });

  it('surfaces the mandate a seeded root case actually used', async () => {
    const db = createDb(TEST_DB);
    insertMandate(db, { id: 'm1', name: 'Focused', description: '', authority: contract().authority, constraints: [], builtin: false, createdAt: 't0', updatedAt: 't0' });
    insertNode(db, { id: 'root', parentId: null, goal: 'g', contract: contract(), state: 'COMPLETE', repoPath: '/repo', mandateId: 'm1', runtime: 'claude-code', createdAt: 't0', updatedAt: 't0' });

    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'GET', url: '/trpc/case.facets' });
    const data = JSON.parse(response.body).result.data;
    expect(data.runtimes).toEqual(['claude-code']);
    expect(data.repoPaths).toEqual(['/repo']);
    expect(data.mandates).toEqual([{ id: 'm1', name: 'Focused' }]);
  });
});

describe('case router — attention', () => {
  it('returns an empty array when nothing needs a person', async () => {
    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'GET', url: '/trpc/case.attention' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data).toEqual([]);
  });

  it('surfaces a pending approval as an attention item', async () => {
    const db = createDb(TEST_DB);
    seedRoot(db);
    insertApproval(db, { id: 'a1', nodeId: 'root', reason: 'over budget', status: 'pending', createdAt: 't0' });

    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'GET', url: '/trpc/case.attention' });
    const data = JSON.parse(response.body).result.data;
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ kind: 'approval', nodeId: 'root', approvalId: 'a1' });
  });
});

describe('case router — file', () => {
  it('assembles one case file from every seeded part', async () => {
    const db = createDb(TEST_DB);
    insertMandate(db, { id: 'm1', name: 'Focused', description: '', authority: contract().authority, constraints: [], builtin: false, createdAt: 't0', updatedAt: 't0' });
    insertNode(db, { id: 'root', parentId: null, goal: 'ship the thing', contract: contract(), state: 'COMPLETE', repoPath: null, mandateId: 'm1', createdAt: 't0', updatedAt: 't0' });
    insertDodItems(db, 'root', ['a check'], 't0', (i) => `dod-root-${i}`);
    insertCommitment(db, { id: 'commit-root', owner: 'root', goal: 'ship the thing', definition_of_done: ['a check'], status: 'pending', created_at: 't0', dependencies: [], evidence: [], risks: [] }, 't0');
    insertArtifact(db, { id: 'art1', nodeId: 'root', kind: 'file', path: null, summary: 's', createdAt: 't0' });
    insertApproval(db, { id: 'a1', nodeId: 'root', reason: 'r', status: 'approved', createdAt: 't0', resolvedAt: 't0' });
    appendEvent(db, { nodeId: 'root', type: 'exec.result', payload: { total_cost_usd: 1, result: 'done' }, createdAt: 't0' });

    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({ id: 'root' }));
    const response = await app.inject({ method: 'GET', url: `/trpc/case.file?input=${input}` });
    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body).result.data;
    expect(data.node.id).toBe('root');
    expect(data.mandate.id).toBe('m1');
    expect(data.agents).toBe(1);
    expect(data.dod.progress.total).toBe(1);
    expect(data.artifacts).toHaveLength(1);
    expect(data.approvals).toHaveLength(1);
    expect(data.answer).toBe('done');
  });

  it('throws (not a 200) for a case id that does not exist', async () => {
    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({ id: 'does-not-exist' }));
    const response = await app.inject({ method: 'GET', url: `/trpc/case.file?input=${input}` });
    expect(response.statusCode).toBe(500);
  });

  it('rejects a request with no id via the Zod validation path, not a 500', async () => {
    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({}));
    const response = await app.inject({ method: 'GET', url: `/trpc/case.file?input=${input}` });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.data.code).toBe('BAD_REQUEST');
  });
});

describe('case router — custody', () => {
  it('returns the chain of custody for a seeded node', async () => {
    const db = createDb(TEST_DB);
    seedRoot(db);
    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({ nodeId: 'root' }));
    const response = await app.inject({ method: 'GET', url: `/trpc/case.custody?input=${input}` });
    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body).result.data;
    expect(data.origin).toBe('human');
    expect(data.hops).toHaveLength(1);
    expect(data.hops[0].nodeId).toBe('root');
  });

  it('returns an empty chain for a node id that does not exist, rather than throwing', async () => {
    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({ nodeId: 'does-not-exist' }));
    const response = await app.inject({ method: 'GET', url: `/trpc/case.custody?input=${input}` });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data.hops).toEqual([]);
  });

  it('rejects a request with no nodeId via the Zod validation path, not a 500', async () => {
    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({}));
    const response = await app.inject({ method: 'GET', url: `/trpc/case.custody?input=${input}` });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.data.code).toBe('BAD_REQUEST');
  });
});

describe('case router — receipt', () => {
  it('assembles the exported-file view from every seeded part', async () => {
    const db = createDb(TEST_DB);
    seedRoot(db);
    insertDecision(db, { id: 'd1', nodeId: 'root', type: 'execution_decision', outcome: 'SELF_EXECUTE', breakdown: { score: 0.1 }, createdAt: 't0' });
    appendEvent(db, { nodeId: 'root', type: 'authority.denied', payload: { tool: 'Bash' }, createdAt: 't0' });

    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({ id: 'root' }));
    const response = await app.inject({ method: 'GET', url: `/trpc/case.receipt?input=${input}` });
    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body).result.data;
    expect(data.node.id).toBe('root');
    expect(data.decisions).toHaveLength(1);
    expect(data.denials).toHaveLength(1);
    expect(typeof data.generatedAt).toBe('string');
  });

  it('throws (not a 200) for a case id that does not exist', async () => {
    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({ id: 'does-not-exist' }));
    const response = await app.inject({ method: 'GET', url: `/trpc/case.receipt?input=${input}` });
    expect(response.statusCode).toBe(500);
  });

  it('rejects a request with no id via the Zod validation path, not a 500', async () => {
    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({}));
    const response = await app.inject({ method: 'GET', url: `/trpc/case.receipt?input=${input}` });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.data.code).toBe('BAD_REQUEST');
  });
});
