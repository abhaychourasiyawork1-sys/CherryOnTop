import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { buildServer } from '../app.js';
import { createDb } from '../../db/client.js';
import { insertMandate } from '../../db/queries/mandates.js';

const TEST_DB = './test-mandate-router.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const authority = (budget: number, tools: string[] = []) =>
  ({ tools, spawn_children: false, max_child_count: 0, budget_usd: budget });

describe('mandate router — list', () => {
  it('includes the seeded builtin mandates', async () => {
    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'GET', url: '/trpc/mandate.list' });
    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body).result.data;
    expect(data.length).toBeGreaterThanOrEqual(3);
    expect(data.map((m: { id: string }) => m.id)).toEqual(expect.arrayContaining(['builtin-investigate']));
    // Every row carries the human-readable summary alongside the raw authority.
    expect(typeof data[0].summary).toBe('string');
  });

  it('also lists a custom mandate that was created', async () => {
    const db = createDb(TEST_DB);
    insertMandate(db, {
      id: 'custom-1', name: 'Custom', description: '', authority: authority(4, ['Read']),
      constraints: [], builtin: false, createdAt: 't0', updatedAt: 't0',
    });
    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'GET', url: '/trpc/mandate.list' });
    const data = JSON.parse(response.body).result.data;
    expect(data.map((m: { id: string }) => m.id)).toContain('custom-1');
  });
});

describe('mandate router — get', () => {
  it('returns a seeded mandate by id', async () => {
    const db = createDb(TEST_DB);
    insertMandate(db, {
      id: 'custom-1', name: 'Custom', description: 'desc', authority: authority(4, ['Read']),
      constraints: ['no writes'], builtin: false, createdAt: 't0', updatedAt: 't0',
    });
    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({ id: 'custom-1' }));
    const response = await app.inject({ method: 'GET', url: `/trpc/mandate.get?input=${input}` });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data.name).toBe('Custom');
  });

  it('throws (not a 200) for a mandate id that does not exist', async () => {
    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({ id: 'does-not-exist' }));
    const response = await app.inject({ method: 'GET', url: `/trpc/mandate.get?input=${input}` });
    expect(response.statusCode).toBe(500);
  });

  it('rejects a request with no id via the Zod validation path, not a 500', async () => {
    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({}));
    const response = await app.inject({ method: 'GET', url: `/trpc/mandate.get?input=${input}` });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.data.code).toBe('BAD_REQUEST');
  });
});

describe('mandate router — simulate', () => {
  it('describes what a proposed authority permits, with no db writes', async () => {
    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({ authority: authority(5, ['Read', 'Write']) }));
    const response = await app.inject({ method: 'GET', url: `/trpc/mandate.simulate?input=${input}` });
    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body).result.data;
    expect(data.envelope.permits.length).toBeGreaterThan(0);
    expect(typeof data.summary).toBe('string');
  });

  it('rejects a negative budget via the Zod validation path, not a 500', async () => {
    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({ authority: authority(-5) }));
    const response = await app.inject({ method: 'GET', url: `/trpc/mandate.simulate?input=${input}` });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.data.code).toBe('BAD_REQUEST');
  });
});

describe('mandate router — create', () => {
  it('creates a mandate that is then readable via get', async () => {
    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({
      method: 'POST', url: '/trpc/mandate.create',
      payload: { name: 'New mandate', authority: authority(3, ['Read']) },
    });
    expect(response.statusCode).toBe(200);
    const { id } = JSON.parse(response.body).result.data;
    expect(typeof id).toBe('string');

    const input = encodeURIComponent(JSON.stringify({ id }));
    const getResponse = await app.inject({ method: 'GET', url: `/trpc/mandate.get?input=${input}` });
    expect(JSON.parse(getResponse.body).result.data.name).toBe('New mandate');
  });

  it('rejects an empty name via the Zod validation path, not a 500', async () => {
    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({
      method: 'POST', url: '/trpc/mandate.create',
      payload: { name: '', authority: authority(1) },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.data.code).toBe('BAD_REQUEST');
  });
});

describe('mandate router — update', () => {
  it('patches a seeded mandate', async () => {
    const db = createDb(TEST_DB);
    insertMandate(db, {
      id: 'custom-1', name: 'Old name', description: '', authority: authority(1),
      constraints: [], builtin: false, createdAt: 't0', updatedAt: 't0',
    });
    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({
      method: 'POST', url: '/trpc/mandate.update',
      payload: { id: 'custom-1', name: 'New name' },
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data).toEqual({ ok: true });

    const input = encodeURIComponent(JSON.stringify({ id: 'custom-1' }));
    const getResponse = await app.inject({ method: 'GET', url: `/trpc/mandate.get?input=${input}` });
    expect(JSON.parse(getResponse.body).result.data.name).toBe('New name');
  });

  it('throws (not a 200) when updating a mandate id that does not exist', async () => {
    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({
      method: 'POST', url: '/trpc/mandate.update',
      payload: { id: 'does-not-exist', name: 'x' },
    });
    expect(response.statusCode).toBe(500);
  });

  it('rejects a request with no id via the Zod validation path, not a 500', async () => {
    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'POST', url: '/trpc/mandate.update', payload: { name: 'x' } });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.data.code).toBe('BAD_REQUEST');
  });
});

describe('mandate router — delete', () => {
  it('deletes a seeded custom mandate', async () => {
    const db = createDb(TEST_DB);
    insertMandate(db, {
      id: 'custom-1', name: 'Custom', description: '', authority: authority(1),
      constraints: [], builtin: false, createdAt: 't0', updatedAt: 't0',
    });
    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'POST', url: '/trpc/mandate.delete', payload: { id: 'custom-1' } });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data).toEqual({ ok: true });

    const listResponse = await app.inject({ method: 'GET', url: '/trpc/mandate.list' });
    expect(JSON.parse(listResponse.body).result.data.map((m: { id: string }) => m.id)).not.toContain('custom-1');
  });

  it('is idempotent for an id that does not exist — no error, nothing to delete', async () => {
    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'POST', url: '/trpc/mandate.delete', payload: { id: 'does-not-exist' } });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data).toEqual({ ok: true });
  });

  it('refuses to delete a builtin mandate', async () => {
    const app = buildServer(TEST_DB, () => {});
    const response = await app.inject({ method: 'POST', url: '/trpc/mandate.delete', payload: { id: 'builtin-investigate' } });
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body).error.message).toContain('built-in');
  });
});

// Security boundary: a mandate is the object the whole authority model is
// built on, so what the API hands back for it must be exactly what is stored —
// never a wider budget, a wider tool set, or delegation the mandate never
// granted.
describe('mandate router — authority never widens beyond what is stored', () => {
  it('get and list both echo the stored authority exactly, not a broadened version of it', async () => {
    const db = createDb(TEST_DB);
    insertMandate(db, {
      id: 'restricted', name: 'Restricted', description: '',
      authority: { tools: ['Read'], spawn_children: false, max_child_count: 0, budget_usd: 1 },
      constraints: ['read only'], builtin: false, createdAt: 't0', updatedAt: 't0',
    });
    const app = buildServer(TEST_DB, () => {});

    const input = encodeURIComponent(JSON.stringify({ id: 'restricted' }));
    const getData = JSON.parse((await app.inject({ method: 'GET', url: `/trpc/mandate.get?input=${input}` })).body).result.data;
    expect(getData.authority).toEqual({ tools: ['Read'], spawn_children: false, max_child_count: 0, budget_usd: 1 });

    const listData = JSON.parse((await app.inject({ method: 'GET', url: '/trpc/mandate.list' })).body).result.data;
    const inList = listData.find((m: { id: string }) => m.id === 'restricted');
    expect(inList.authority.budget_usd).toBe(1);
    expect(inList.authority.tools).toEqual(['Read']);
    expect(inList.authority.spawn_children).toBe(false);
  });

  it('create stores exactly the authority it was given, never a wider one', async () => {
    const app = buildServer(TEST_DB, () => {});
    const createResponse = await app.inject({
      method: 'POST', url: '/trpc/mandate.create',
      payload: { name: 'Narrow', authority: { tools: ['Read'], spawn_children: false, max_child_count: 0, budget_usd: 1 } },
    });
    const { id } = JSON.parse(createResponse.body).result.data;
    const input = encodeURIComponent(JSON.stringify({ id }));
    const data = JSON.parse((await app.inject({ method: 'GET', url: `/trpc/mandate.get?input=${input}` })).body).result.data;
    expect(data.authority.budget_usd).toBe(1);
    expect(data.authority.tools).toEqual(['Read']);
    expect(data.authority.spawn_children).toBe(false);
  });
});
