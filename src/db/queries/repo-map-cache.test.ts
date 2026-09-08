import { it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { getRepoMap, putRepoMap } from './repo-map-cache.js';

const DB = './test-repomap.db';
afterEach(() => { for (const s of ['', '-journal', '-wal', '-shm']) if (existsSync(DB + s)) unlinkSync(DB + s); });

it('stores and retrieves a map by repo head, null when absent', () => {
  const db = createDb(DB);
  expect(getRepoMap(db, 'headX')).toBeNull();
  putRepoMap(db, 'headX', 'THE MAP', new Date().toISOString());
  expect(getRepoMap(db, 'headX')).toBe('THE MAP');
});
