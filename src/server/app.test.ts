import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { buildServer } from './app.js';

const TEST_DB = './test-app.db';

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

describe('Fastify + tRPC app', () => {
  it('responds to daemon.ping', async () => {
    const app = buildServer(TEST_DB);
    const response = await app.inject({ method: 'GET', url: '/trpc/daemon.ping' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.result.data.ok).toBe(true);
  });

  it('creates a node via node.create and retrieves it via node.get', async () => {
    const app = buildServer(TEST_DB);
    const createResponse = await app.inject({
      method: 'POST',
      url: '/trpc/node.create',
      payload: {
        goal: 'test goal',
        definition_of_done: ['done'],
        authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 0 },
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const { result } = JSON.parse(createResponse.body);
    const nodeId = result.data.id;
    expect(typeof nodeId).toBe('string');

    const getResponse = await app.inject({ method: 'GET', url: `/trpc/node.get?input=${encodeURIComponent(JSON.stringify({ id: nodeId }))}` });
    const getBody = JSON.parse(getResponse.body);
    expect(getBody.result.data.goal).toBe('test goal');
  });
});
