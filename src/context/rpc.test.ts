import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '../db/client.js';
import { putContextObject } from './store.js';
import { createContextRpc, publishContextVersion } from './rpc.js';
import { isRefusal } from './representations.js';
import { scopeOf } from './types.js';

const TEST_DB = './test-context-rpc.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const reader = scopeOf(['Read'], true);
const narrow = scopeOf(['Read'], true);
const SOURCE = 'export function login() {\n  return 1;\n}\n';

function fixture() {
  const worktreePath = mkdtempSync(join(tmpdir(), 'rpc-'));
  writeFileSync(join(worktreePath, 'auth.ts'), SOURCE);
  const db = createDb(TEST_DB);
  const object = putContextObject(db, {
    semanticId: 'repo_file:auth.ts', kind: 'repo_file', content: SOURCE,
    source: { kind: 'repo', locator: 'auth.ts' }, scope: reader,
  });
  return { db, object, worktreePath, rpc: createContextRpc(db, reader) };
}

describe('the context RPC', () => {
  it('resolves one ref and many', () => {
    const { db, object, rpc } = fixture();
    const other = putContextObject(db, {
      semanticId: 'repo_file:cart.ts', kind: 'repo_file', content: 'cart',
      source: { kind: 'repo', locator: 'cart.ts' }, scope: reader,
    });
    expect(rpc.resolve(object.ref)?.ref).toEqual(object.ref);
    expect(rpc.resolveMany([object.ref, other.ref])).toHaveLength(2);
    expect(rpc.resolve({ ...object.ref, contentHash: 'nope' })).toBeUndefined();
  });

  it('cannot be called without a scope, and enforces it on every method', () => {
    // The reason these sit behind one object rather than being exported
    // directly: there is nowhere to call from without passing a scope.
    const { db, worktreePath } = fixture();
    const secret = putContextObject(db, {
      semanticId: 'repo_file:secret.ts', kind: 'repo_file', content: 'secret',
      source: { kind: 'repo', locator: 'secret.ts' }, scope: scopeOf(null, true),
    });
    const rpc = createContextRpc(db, narrow);
    expect(rpc.resolve(secret.ref)).toBeUndefined();
    expect(rpc.resolveMany([secret.ref])).toEqual([]);
    expect(rpc.inspect(secret.ref)).toBeUndefined();
    expect(rpc.search({ text: 'secret' })).toEqual([]);
    expect(isRefusal(rpc.expandTo(secret.ref, 'full', 10_000, worktreePath))).toBe(true);
  });

  it('expands to the cheapest representation that fits', () => {
    const { object, worktreePath, rpc } = fixture();
    const small = rpc.expandTo(object.ref, 'reference', 6, worktreePath);
    const large = rpc.expandTo(object.ref, 'reference', 100_000, worktreePath);
    if (isRefusal(small) || isRefusal(large)) throw new Error('expected both to materialize');
    expect(small.tokens).toBeLessThanOrEqual(6);
    // The most informative thing that fits, which under 6 tokens is the
    // signature — not the bare path, and never the full file.
    expect(small.representation).not.toBe('full');
    expect(large.representation).toBe('full');

    // A budget too small even for a bare identity refuses rather than emitting
    // a fragment that still busts it.
    expect(isRefusal(rpc.expandTo(object.ref, 'reference', 1, worktreePath))).toBe(true);
  });

  it('runs a narrow expansion', () => {
    const { object, worktreePath, rpc } = fixture();
    const result = rpc.expand({ op: 'GET_SYMBOL', ref: object.ref, symbol: 'login', worktreePath });
    if (isRefusal(result)) throw new Error(result.reason);
    expect(result.content).toContain('login');
  });

  it('diffs two versions of one identity', () => {
    const { db, rpc } = fixture();
    putContextObject(db, {
      semanticId: 'repo_file:auth.ts', kind: 'repo_file', content: 'moved on',
      source: { kind: 'repo', locator: 'auth.ts' }, scope: reader,
    });
    const delta = rpc.diff('repo_file:auth.ts', 1, 2);
    expect(delta.changed).toHaveLength(1);
    expect(delta.changed[0].from.version).toBe(1);
    expect(delta.changed[0].to.version).toBe(2);
  });

  it('treats a diff against a version that never existed as empty, not an error', () => {
    // A caller holding an old ref is the normal case, not a fault.
    const { rpc } = fixture();
    const delta = rpc.diff('repo_file:auth.ts', 1, 99);
    expect(delta.removed).toHaveLength(1);
    expect(delta.added).toHaveLength(0);
  });

  it('inspects without materializing', () => {
    const { object, rpc } = fixture();
    const inspection = rpc.inspect(object.ref)!;
    expect(inspection.kind).toBe('repo_file');
    expect(inspection.latest).toBe(true);
  });
});

describe('subscribe', () => {
  it('delivers versions of one identity as they appear, and stops when asked', async () => {
    const { db, rpc } = fixture();
    const controller = new AbortController();
    const seen: string[] = [];

    const reading = (async () => {
      for await (const event of rpc.subscribe('repo_file:auth.ts', controller.signal)) {
        seen.push(event.ref.contentHash);
        if (seen.length === 2) controller.abort();
      }
    })();

    await new Promise((r) => setTimeout(r, 5));
    for (const content of ['one', 'two']) {
      publishContextVersion(putContextObject(db, {
        semanticId: 'repo_file:auth.ts', kind: 'repo_file', content,
        source: { kind: 'repo', locator: 'auth.ts' }, scope: reader,
      }));
    }

    await reading;
    expect(seen).toHaveLength(2);
  });

  it('ignores versions of other identities', async () => {
    const { db, rpc } = fixture();
    const controller = new AbortController();
    const seen: string[] = [];

    const reading = (async () => {
      for await (const event of rpc.subscribe('repo_file:auth.ts', controller.signal)) seen.push(event.semanticId);
    })();

    await new Promise((r) => setTimeout(r, 5));
    publishContextVersion(putContextObject(db, {
      semanticId: 'repo_file:cart.ts', kind: 'repo_file', content: 'cart',
      source: { kind: 'repo', locator: 'cart.ts' }, scope: reader,
    }));
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await reading;
    expect(seen).toEqual([]);
  });
});
