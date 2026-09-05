import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { buildServer } from './app.js';

const TEST_DB = './test-app.db';

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

// node.create starts a real node, which now walks itself all the way into a live
// Kubernetes dispatch with no external event. Every server built here gets a spy
// in place of that, so a unit test never touches a cluster.
const noopStartNode = () => {};

describe('Fastify + tRPC app', () => {
  it('reports whether the daemon itself holds an API key', async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    const app = buildServer(TEST_DB, () => {});
    try {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      let res = await app.inject({ method: 'GET', url: '/trpc/daemon.ping' });
      expect(JSON.parse(res.body).result.data.hasApiKey).toBe(true);
      delete process.env.ANTHROPIC_API_KEY;
      res = await app.inject({ method: 'GET', url: '/trpc/daemon.ping' });
      expect(JSON.parse(res.body).result.data.hasApiKey).toBe(false);
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = original;
    }
  });

  it('responds to daemon.ping', async () => {
    const app = buildServer(TEST_DB, noopStartNode);
    const response = await app.inject({ method: 'GET', url: '/trpc/daemon.ping' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.result.data.ok).toBe(true);
  });

  it('creates a node via node.create and retrieves it via node.get', async () => {
    const startNode = vi.fn();
    const app = buildServer(TEST_DB, startNode);
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
    expect(startNode).toHaveBeenCalledWith(expect.anything(), nodeId, 'test goal');
  });
});
