import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { buildServer } from '../app.js';
import { createDb } from '../../db/client.js';
import { insertNode } from '../../db/queries/nodes.js';
import { insertArtifact } from '../../db/queries/artifacts.js';

const TEST_DB = './test-artifact-router.db';
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

describe('artifact router — listForNode', () => {
  it('lists artifacts seeded for a node', async () => {
    const db = createDb(TEST_DB);
    insertNode(db, { id: 'n1', parentId: null, goal: 'g', contract, state: 'COMPLETE', repoPath: null, createdAt: 't0', updatedAt: 't0' });
    insertArtifact(db, { id: 'art1', nodeId: 'n1', kind: 'file', path: '/tmp/out.txt', summary: 'wrote a file', createdAt: 't0' });

    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({ nodeId: 'n1' }));
    const response = await app.inject({ method: 'GET', url: `/trpc/artifact.listForNode?input=${input}` });
    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body).result.data;
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('art1');
  });

  it('returns an empty array for a node with no artifacts', async () => {
    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({ nodeId: 'does-not-exist' }));
    const response = await app.inject({ method: 'GET', url: `/trpc/artifact.listForNode?input=${input}` });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data).toEqual([]);
  });

  it('rejects a request with no nodeId via the Zod validation path, not a 500', async () => {
    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({}));
    const response = await app.inject({ method: 'GET', url: `/trpc/artifact.listForNode?input=${input}` });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.data.code).toBe('BAD_REQUEST');
  });
});

describe('artifact router — listForSubtree', () => {
  it('lists artifacts from a node and its children', async () => {
    const db = createDb(TEST_DB);
    insertNode(db, { id: 'parent', parentId: null, goal: 'g', contract, state: 'COMPLETE', repoPath: null, createdAt: 't0', updatedAt: 't0' });
    insertNode(db, { id: 'child', parentId: 'parent', goal: 'g2', contract, state: 'COMPLETE', repoPath: null, createdAt: 't0', updatedAt: 't0' });
    insertArtifact(db, { id: 'art-parent', nodeId: 'parent', kind: 'file', path: null, summary: 'parent output', createdAt: 't0' });
    insertArtifact(db, { id: 'art-child', nodeId: 'child', kind: 'file', path: null, summary: 'child output', createdAt: 't0' });

    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({ nodeId: 'parent' }));
    const response = await app.inject({ method: 'GET', url: `/trpc/artifact.listForSubtree?input=${input}` });
    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body).result.data;
    expect(data.map((a: { id: string }) => a.id).sort()).toEqual(['art-child', 'art-parent']);
  });

  it('returns an empty array for a subtree root that does not exist', async () => {
    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({ nodeId: 'does-not-exist' }));
    const response = await app.inject({ method: 'GET', url: `/trpc/artifact.listForSubtree?input=${input}` });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data).toEqual([]);
  });

  it('rejects a request with no nodeId via the Zod validation path, not a 500', async () => {
    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({}));
    const response = await app.inject({ method: 'GET', url: `/trpc/artifact.listForSubtree?input=${input}` });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.data.code).toBe('BAD_REQUEST');
  });
});
