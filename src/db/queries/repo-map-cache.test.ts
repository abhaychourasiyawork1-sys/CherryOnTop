import { it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { getRepoMap, putRepoMap, getRepoInventory, putRepoInventory } from './repo-map-cache.js';

const DB = './test-repomap.db';
afterEach(() => { for (const s of ['', '-journal', '-wal', '-shm']) if (existsSync(DB + s)) unlinkSync(DB + s); });

it('stores and retrieves a map by repo head, null when absent', () => {
  const db = createDb(DB);
  expect(getRepoMap(db, 'headX')).toBeNull();
  putRepoMap(db, 'headX', 'THE MAP', new Date().toISOString());
  expect(getRepoMap(db, 'headX')).toBe('THE MAP');
});

it('stores and reads back a repository inventory', () => {
  const db = createDb(DB);
  expect(getRepoInventory(db, 'headI')).toBeNull();
  putRepoInventory(db, 'headI', [{ path: 'src/a.ts', symbols: ['alpha'] }], new Date().toISOString());
  expect(getRepoInventory(db, 'headI')).toEqual([{ path: 'src/a.ts', symbols: ['alpha'] }]);
});

it('treats a malformed or empty inventory row as a miss rather than throwing', () => {
  const db = createDb(DB);
  putRepoInventory(db, 'headBad', [{ nonsense: true } as never], new Date().toISOString());
  expect(getRepoInventory(db, 'headBad')).toBeNull();
  putRepoInventory(db, 'headEmpty', [], new Date().toISOString());
  expect(getRepoInventory(db, 'headEmpty')).toBeNull();
});
