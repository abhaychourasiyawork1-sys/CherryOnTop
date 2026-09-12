import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../db/client.js';
import {
  putContextObject, getContextObject, getLatest, listVersions,
  listContextObjects, markFreshness, clearContextObjects, canonicalJson, contentHashOf,
} from './store.js';
import { scopeOf, scopePermits } from './types.js';

const TEST_DB = './test-context-store.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const readOnly = scopeOf(['Read', 'Grep'], true);

const put = (db: ReturnType<typeof createDb>, over: Partial<Parameters<typeof putContextObject>[1]> = {}) =>
  putContextObject(db, {
    semanticId: 'repo_file:src/auth.ts',
    kind: 'repo_file',
    content: 'export const auth = 1;',
    source: { kind: 'repo', locator: 'src/auth.ts' },
    scope: readOnly,
    ...over,
  });

describe('content addressing', () => {
  it('gives the same canonical content the same hash, whatever order it was built in', () => {
    const a = contentHashOf({
      content: 'x', kind: 'repo_file', source: { kind: 'repo', locator: 'p' },
      scope: scopeOf(['Grep', 'Read'], true), dependencies: [],
    });
    const b = contentHashOf({
      content: 'x', kind: 'repo_file', source: { kind: 'repo', locator: 'p' },
      scope: scopeOf(['Read', 'Grep'], true), dependencies: [],
    });
    expect(a).toBe(b);
  });

  it('separates identical bytes produced under different grants', () => {
    // Not pedantry: a hash that cannot tell these apart lets an object produced
    // under a wide grant be served to a narrow consumer.
    const base = { content: 'x', kind: 'repo_file' as const, source: { kind: 'repo' as const, locator: 'p' }, dependencies: [] };
    expect(contentHashOf({ ...base, scope: scopeOf(['Read'], true) }))
      .not.toBe(contentHashOf({ ...base, scope: scopeOf(null, true) }));
  });

  it('orders object keys so two ways of writing the same value agree', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }))
      .toBe(canonicalJson({ a: [2, { c: 3, d: 4 }], b: 1 }));
  });
});

describe('semantic identity and versions', () => {
  it('does not version the same content twice', () => {
    const db = createDb(TEST_DB);
    const first = put(db);
    const again = put(db);
    expect(again.ref).toEqual(first.ref);
    expect(listVersions(db, 'repo_file:src/auth.ts')).toHaveLength(1);
  });

  it('gives one semantic identity many versions as its content moves', () => {
    const db = createDb(TEST_DB);
    const v1 = put(db);
    const v2 = put(db, { content: 'export const auth = 2;' });
    expect(v1.ref.version).toBe(1);
    expect(v2.ref.version).toBe(2);
    expect(v2.ref.semanticId).toBe(v1.ref.semanticId);
    expect(v2.ref.contentHash).not.toBe(v1.ref.contentHash);
    expect(getLatest(db, 'repo_file:src/auth.ts')?.ref).toEqual(v2.ref);
  });

  it('marks the version it overtook as stale rather than deleting it', () => {
    // A ref is a permanent name for a fact. Deleting the old version would make
    // every receipt that quoted it unresolvable.
    const db = createDb(TEST_DB);
    const v1 = put(db);
    put(db, { content: 'moved on' });
    expect(getContextObject(db, v1.ref)?.freshness).toBe('STALE');
    expect(getContextObject(db, v1.ref)?.ref).toEqual(v1.ref);
  });

  it('resolves an exact ref and refuses one that does not exist', () => {
    const db = createDb(TEST_DB);
    const object = put(db);
    expect(getContextObject(db, object.ref)?.ref.contentHash).toBe(object.ref.contentHash);
    expect(getContextObject(db, { ...object.ref, contentHash: 'nope' })).toBeUndefined();
  });
});

describe('security scope in reuse validity', () => {
  it('lets a wider consumer reuse what a narrower producer saw, never the reverse', () => {
    const narrow = scopeOf(['Read'], true);
    const wide = scopeOf(['Read', 'Grep'], true);
    expect(scopePermits(narrow, wide)).toBe(true);
    expect(scopePermits(wide, narrow)).toBe(false);
    // Unrestricted is only reusable by unrestricted.
    expect(scopePermits(scopeOf(null, true), wide)).toBe(false);
    expect(scopePermits(narrow, scopeOf(null, true))).toBe(true);
  });

  it('never mixes a writer’s output with a reader’s question', () => {
    expect(scopePermits(scopeOf(['Read'], false), scopeOf(['Read'], true))).toBe(false);
  });
});

describe('the store as a derived index', () => {
  it('stores a pointer to canonical evidence rather than a copy of it', () => {
    const db = createDb(TEST_DB);
    const object = putContextObject(db, {
      semanticId: 'observation:tool-1', kind: 'observation',
      content: 'x'.repeat(100_000),
      source: { kind: 'artifact', locator: 'artifact-1' },
      scope: readOnly,
    });
    expect(object.inline).toBeUndefined();
    expect(object.source).toEqual({ kind: 'artifact', locator: 'artifact-1' });
    // The size is still known, so a projection can budget without materializing.
    expect(object.tokens).toBe(25_000);
  });

  it('can be thrown away and rebuilt from the evidence it indexes', () => {
    // The property that makes this a store and not a source of truth. If the
    // index could not be dropped, canonical truth would have quietly moved into
    // it.
    const db = createDb(TEST_DB);
    const evidence = [
      { id: 'repo_file:a.ts', content: 'a' },
      { id: 'repo_file:b.ts', content: 'b' },
    ];
    for (const item of evidence) {
      putContextObject(db, {
        semanticId: item.id, kind: 'repo_file', content: item.content,
        source: { kind: 'repo', locator: item.id }, scope: readOnly,
      });
    }
    const before = listContextObjects(db).map((o) => o.ref.contentHash).sort();

    clearContextObjects(db);
    expect(listContextObjects(db)).toEqual([]);

    for (const item of evidence) {
      putContextObject(db, {
        semanticId: item.id, kind: 'repo_file', content: item.content,
        source: { kind: 'repo', locator: item.id }, scope: readOnly,
      });
    }
    expect(listContextObjects(db).map((o) => o.ref.contentHash).sort()).toEqual(before);
  });

  it('records freshness without touching what the object says', () => {
    const db = createDb(TEST_DB);
    const object = put(db);
    markFreshness(db, object.ref, 'INVALID');
    const after = getContextObject(db, object.ref)!;
    expect(after.freshness).toBe('INVALID');
    expect(after.ref.contentHash).toBe(object.ref.contentHash);
  });
});
