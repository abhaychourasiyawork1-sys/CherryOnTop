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
  putRepoInventory(db, 'headI', [{ path: 'src/a.ts', symbols: ['alpha'], imports: [] }], new Date().toISOString());
  expect(getRepoInventory(db, 'headI')).toEqual([{ path: 'src/a.ts', symbols: ['alpha'], imports: [] }]);
});

it('treats a malformed or empty inventory row as a miss rather than throwing', () => {
  const db = createDb(DB);
  putRepoInventory(db, 'headBad', [{ nonsense: true } as never], new Date().toISOString());
  expect(getRepoInventory(db, 'headBad')).toBeNull();
  putRepoInventory(db, 'headEmpty', [], new Date().toISOString());
  expect(getRepoInventory(db, 'headEmpty')).toBeNull();
});

it('treats an inventory scanned before import extraction as a miss, not as a file that imports nothing', () => {
  const db = createDb(DB);
  // Exactly what the previous scanner wrote: paths and symbols, no edges. It
  // looks healthy, and serving it would silently degrade the structural
  // planner to lexical selection for the whole life of that commit.
  const legacy = [{ path: 'src/a.ts', symbols: ['a'] }] as unknown as Parameters<typeof putRepoInventory>[2];
  putRepoInventory(db, 'head-legacy', legacy, '2026-09-13T00:00:00.000Z');

  expect(getRepoInventory(db, 'head-legacy')).toBeNull();
});

it('serves an inventory that carries its edges', () => {
  const db = createDb(DB);
  putRepoInventory(db, 'head-new', [{ path: 'src/a.ts', symbols: ['a'], imports: ['./b.js'] }], '2026-09-13T00:00:00.000Z');
  expect(getRepoInventory(db, 'head-new')).toEqual([{ path: 'src/a.ts', symbols: ['a'], imports: ['./b.js'] }]);
});
