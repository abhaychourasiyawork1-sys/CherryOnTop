import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { buildServer } from '../app.js';

const TEST_DB = './test-commitment-router.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

describe('commitment router', () => {
  it('lists commitments for a node id', async () => {
    const app = buildServer(TEST_DB);
    const input = encodeURIComponent(JSON.stringify({ nodeId: 'does-not-exist' }));
    const response = await app.inject({ method: 'GET', url: `/trpc/commitment.listForNode?input=${input}` });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data).toEqual([]);
  });
});
