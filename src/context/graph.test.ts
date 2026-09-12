import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../db/client.js';
import { putContextObject } from './store.js';
import { dependenciesOf, dependentsOf, transitiveDependents, search, inspect } from './graph.js';
import { scopeOf, type ContextRef } from './types.js';

const TEST_DB = './test-context-graph.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const reader = scopeOf(['Read', 'Grep'], true);
const narrow = scopeOf(['Read'], true);
type Db = ReturnType<typeof createDb>;

const file = (db: Db, path: string, content = path, scope = reader) => putContextObject(db, {
  semanticId: `repo_file:${path}`, kind: 'repo_file', content,
  source: { kind: 'repo', locator: path }, scope,
}).ref;

const derived = (db: Db, id: string, from: ContextRef[], scope = reader) => putContextObject(db, {
  semanticId: id, kind: 'summary', content: id,
  source: { kind: 'inline', locator: id }, scope,
  dependencies: from.map((ref) => ({ kind: 'DERIVED_FROM' as const, ref })),
}).ref;

describe('typed edge traversal', () => {
  it('walks to what an object came from, and back to what would break', () => {
    const db = createDb(TEST_DB);
    const auth = file(db, 'src/auth.ts');
    const cart = file(db, 'src/cart.ts');
    const summary = derived(db, 'summary:auth-and-cart', [auth, cart]);

    expect(dependenciesOf(db, summary, reader).map((o) => o.ref.semanticId).sort())
      .toEqual(['repo_file:src/auth.ts', 'repo_file:src/cart.ts']);
    expect(dependentsOf(db, auth, reader).map((o) => o.ref.semanticId)).toEqual(['summary:auth-and-cart']);
    // An unrelated file has no dependents — the property invalidation rests on.
    expect(dependentsOf(db, file(db, 'docs/readme.md'), reader)).toEqual([]);
  });

  it('filters by edge kind, so a traversal asks a real question', () => {
    const db = createDb(TEST_DB);
    const auth = file(db, 'src/auth.ts');
    const summary = putContextObject(db, {
      semanticId: 'summary:x', kind: 'summary', content: 'x',
      source: { kind: 'inline', locator: 'x' }, scope: reader,
      dependencies: [{ kind: 'SUMMARIZES', ref: auth }],
    }).ref;
    expect(dependenciesOf(db, summary, reader, 'SUMMARIZES')).toHaveLength(1);
    expect(dependenciesOf(db, summary, reader, 'DEPENDS_ON')).toHaveLength(0);
  });

  it('follows dependents transitively, bounded by depth', () => {
    const db = createDb(TEST_DB);
    const root = file(db, 'src/session.ts');
    const first = derived(db, 'summary:1', [root]);
    const second = derived(db, 'summary:2', [first]);
    derived(db, 'summary:3', [second]);

    expect(transitiveDependents(db, root, reader).map((o) => o.ref.semanticId).sort())
      .toEqual(['summary:1', 'summary:2', 'summary:3']);
    expect(transitiveDependents(db, root, reader, 1).map((o) => o.ref.semanticId))
      .toEqual(['summary:1']);
  });

  it('does not loop forever on a cycle', () => {
    // Versions make a true cycle hard to build, but an object depending on an
    // earlier version of itself is ordinary — and an unguarded walk on it hangs
    // the daemon.
    const db = createDb(TEST_DB);
    const v1 = file(db, 'src/a.ts', 'one');
    const v2 = putContextObject(db, {
      semanticId: 'repo_file:src/a.ts', kind: 'repo_file', content: 'two',
      source: { kind: 'repo', locator: 'src/a.ts' }, scope: reader,
      dependencies: [{ kind: 'SUPERSEDES', ref: v1 }],
    }).ref;
    expect(transitiveDependents(db, v1, reader).map((o) => o.ref.version)).toEqual([v2.version]);
  });
});

describe('search', () => {
  it('filters by scope before ranking, never after', () => {
    // Ranking first leaks the existence of objects the consumer may not see,
    // through the ordering and the count of what survives.
    const db = createDb(TEST_DB);
    file(db, 'src/session.ts', 'visible', narrow);
    file(db, 'src/session-secret.ts', 'hidden', scopeOf(null, true));

    const found = search(db, { text: 'session' }, narrow);
    expect(found.map((r) => r.semanticId)).toEqual(['repo_file:src/session.ts']);
  });

  it('ranks by how many query terms an identity answers to', () => {
    const db = createDb(TEST_DB);
    file(db, 'src/session-store.ts');
    file(db, 'src/session.ts');
    file(db, 'docs/readme.md');

    const found = search(db, { text: 'session store' }, reader);
    expect(found[0].semanticId).toBe('repo_file:src/session-store.ts');
    expect(found.map((r) => r.semanticId)).not.toContain('repo_file:docs/readme.md');
  });

  it('treats the token budget as a ceiling, and leaving it unused is allowed', () => {
    const db = createDb(TEST_DB);
    file(db, 'src/a.ts', 'x'.repeat(4000));   // 1000 tokens
    file(db, 'src/b.ts', 'x'.repeat(40));     // 10 tokens

    const found = search(db, { text: 'src a b', tokenBudget: 100 }, reader);
    expect(found.map((r) => r.semanticId)).toEqual(['repo_file:src/b.ts']);
    // Nothing is added merely to fill the budget.
    expect(search(db, { text: 'src a b', tokenBudget: 100_000 }, reader)).toHaveLength(2);
  });

  it('can be restricted to the newest version of each identity', () => {
    const db = createDb(TEST_DB);
    file(db, 'src/a.ts', 'one');
    const v2 = file(db, 'src/a.ts', 'two');
    expect(search(db, { text: 'a', latestOnly: true }, reader)).toEqual([v2]);
    expect(search(db, { text: 'a' }, reader)).toHaveLength(2);
  });

  it('returns the same order for the same query, so a projection can be cached', () => {
    const db = createDb(TEST_DB);
    file(db, 'src/a.ts');
    file(db, 'src/b.ts');
    expect(search(db, { text: 'src' }, reader)).toEqual(search(db, { text: 'src' }, reader));
  });
});

describe('inspect', () => {
  it('answers metadata questions without materializing content', () => {
    const db = createDb(TEST_DB);
    const v1 = file(db, 'src/a.ts', 'x'.repeat(40_000));
    const summary = derived(db, 'summary:a', [v1]);

    const inspection = inspect(db, v1, reader)!;
    expect(inspection.tokens).toBe(10_000);
    expect(inspection.dependentCount).toBe(1);
    expect(inspection.latest).toBe(true);
    expect(inspection).not.toHaveProperty('content');
    expect(inspection).not.toHaveProperty('inline');

    file(db, 'src/a.ts', 'moved on');
    const after = inspect(db, v1, reader)!;
    expect(after.latest).toBe(false);
    expect(after.versions).toBe(2);
    expect(after.freshness).toBe('STALE');
    expect(inspect(db, summary, reader)!.dependencyCount).toBe(1);
  });

  it('refuses an object the consumer may not see', () => {
    const db = createDb(TEST_DB);
    const secret = file(db, 'src/secret.ts', 'x', scopeOf(null, true));
    expect(inspect(db, secret, narrow)).toBeUndefined();
  });
});
