import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../../db/client.js';
import { putContextObject, markFreshness } from '../store.js';
import { scopeOf, type ContextRef } from '../types.js';
import {
  applyManifestDelta, getManifest, describeManifest, MANIFEST_REVISIONS_KEPT,
} from './task-context-manifest.js';

const TEST_DB = './test-task-manifest.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const scope = scopeOf(['Read'], true);
const object = (db: ReturnType<typeof createDb>, id: string, content = 'bytes', kind: 'repo_file' | 'finding' | 'observation' = 'repo_file') =>
  putContextObject(db, { semanticId: id, kind, content, source: { kind: 'inline', locator: id }, scope });

describe('task context manifest', () => {
  it('has nothing for a task nobody has recorded anything for', () => {
    expect(getManifest(createDb(TEST_DB), 't1')).toBeNull();
  });

  it('records refs by section and moves the revision once per batch that changed something', () => {
    const db = createDb(TEST_DB);
    const a = object(db, 'repo_file:a.ts@h1');
    const b = object(db, 'repo_file:b.ts@h1');
    const first = applyManifestDelta(db, 't1', { add: { workingSet: [a.ref, b.ref] }, repositoryRevision: 'h1' });
    expect(first.changed).toBe(true);
    expect(first.manifest.revision).toBe(1);
    expect(first.manifest.workingSet.map((r) => r.semanticId)).toEqual(['repo_file:a.ts@h1', 'repo_file:b.ts@h1']);
    expect(first.manifest.repositoryRevision).toBe('h1');

    const c = object(db, 'finding:child-1', 'a finding', 'finding');
    const second = applyManifestDelta(db, 't1', { add: { facts: [c.ref], validation: [] } });
    expect(second.manifest.revision).toBe(2);
    expect(second.manifest.facts).toEqual([c.ref]);
    expect(second.manifest.workingSet).toHaveLength(2);
  });

  it('does not move the revision for a delta that adds nothing new', () => {
    const db = createDb(TEST_DB);
    const a = object(db, 'repo_file:a.ts@h1');
    applyManifestDelta(db, 't1', { add: { workingSet: [a.ref] } });
    const again = applyManifestDelta(db, 't1', { add: { workingSet: [a.ref] } });
    expect(again.changed).toBe(false);
    expect(again.manifest.revision).toBe(1);
    expect(applyManifestDelta(db, 't1', {}).changed).toBe(false);
  });

  it('names the same set of refs with the same content revision, whatever order they arrived in', () => {
    const db = createDb(TEST_DB);
    const a = object(db, 'repo_file:a.ts@h1');
    const b = object(db, 'repo_file:b.ts@h1');
    const x = applyManifestDelta(db, 'tx', { add: { workingSet: [a.ref, b.ref] } });
    const y = applyManifestDelta(db, 'ty', { add: { workingSet: [b.ref] } });
    const z = applyManifestDelta(db, 'ty', { add: { workingSet: [a.ref] } });
    expect(z.manifest.contentRevision).toBe(x.manifest.contentRevision);
    expect(y.manifest.contentRevision).not.toBe(x.manifest.contentRevision);
  });

  it('stores references only: a large payload costs the manifest a ref, not its bytes', () => {
    const db = createDb(TEST_DB);
    const big = object(db, 'observation:Bash:abc', 'x'.repeat(200_000), 'observation');
    const { manifest } = applyManifestDelta(db, 't1', { add: { artifacts: [big.ref] } });
    expect(JSON.stringify(manifest).length).toBeLessThan(700);
    expect(JSON.stringify(manifest)).not.toContain('xxxxxxxx');
  });

  it('replaces an older version of the same identity rather than holding both', () => {
    const db = createDb(TEST_DB);
    const v1 = object(db, 'finding:x', 'first', 'finding');
    applyManifestDelta(db, 't1', { add: { facts: [v1.ref] } });
    const v2 = object(db, 'finding:x', 'second', 'finding');
    const { manifest } = applyManifestDelta(db, 't1', { add: { facts: [v2.ref] } });
    expect(manifest.facts).toEqual([v2.ref]);
  });

  it('rejects refs that do not exist, are superseded, or are known wrong — and says which', () => {
    const db = createDb(TEST_DB);
    const ghost: ContextRef = { semanticId: 'repo_file:ghost@h1', version: 1, contentHash: 'nope' };
    const old = object(db, 'finding:y', 'v1', 'finding');
    object(db, 'finding:y', 'v2', 'finding');
    const bad = object(db, 'finding:z', 'wrong', 'finding');
    markFreshness(db, bad.ref, 'INVALID');
    const gone = object(db, 'finding:w', 'expired', 'finding');
    markFreshness(db, gone.ref, 'EXPIRED');

    const result = applyManifestDelta(db, 't1', { add: { facts: [ghost, old.ref, bad.ref, gone.ref] } });
    expect(result.changed).toBe(false);
    expect(result.rejected.map((r) => r.reason).sort()).toEqual(['expired', 'invalid', 'superseded', 'unknown_ref']);
    expect(getManifest(db, 't1')).toBeNull();
  });

  it('keeps the good refs of a batch that also contained a bad one', () => {
    const db = createDb(TEST_DB);
    const good = object(db, 'repo_file:ok.ts@h1');
    const ghost: ContextRef = { semanticId: 'repo_file:ghost@h1', version: 1, contentHash: 'nope' };
    const result = applyManifestDelta(db, 't1', { add: { workingSet: [ghost, good.ref] } });
    expect(result.manifest.workingSet).toEqual([good.ref]);
    expect(result.rejected).toHaveLength(1);
  });

  it('distinguishes a ref that went stale after it was recorded', () => {
    const db = createDb(TEST_DB);
    const v1 = object(db, 'finding:s', 'v1', 'finding');
    const fine = object(db, 'finding:f', 'stays', 'finding');
    applyManifestDelta(db, 't1', { add: { facts: [v1.ref, fine.ref] } });
    object(db, 'finding:s', 'v2', 'finding');
    const described = describeManifest(db, getManifest(db, 't1')!);
    expect(described.stale.map((s) => s.ref.semanticId)).toEqual(['finding:s']);
    expect(described.stale[0].state).toBe('superseded');
    expect(described.valid.map((r) => r.semanticId)).toEqual(['finding:f']);
  });

  it('removes refs on request', () => {
    const db = createDb(TEST_DB);
    const a = object(db, 'repo_file:a.ts@h1');
    const b = object(db, 'repo_file:b.ts@h1');
    applyManifestDelta(db, 't1', { add: { workingSet: [a.ref, b.ref] } });
    const { manifest, changed } = applyManifestDelta(db, 't1', { remove: { workingSet: [a.ref] } });
    expect(changed).toBe(true);
    expect(manifest.workingSet).toEqual([b.ref]);
  });

  it('survives a restart: a fresh connection reads the same manifest', () => {
    const db = createDb(TEST_DB);
    const a = object(db, 'repo_file:a.ts@h1');
    applyManifestDelta(db, 't1', { add: { workingSet: [a.ref] }, repositoryRevision: 'h1' });
    const reopened = createDb(TEST_DB);
    expect(getManifest(reopened, 't1')?.workingSet).toEqual([a.ref]);
  });

  it('bounds its own history and keeps the newest revision', () => {
    const db = createDb(TEST_DB);
    for (let i = 0; i < MANIFEST_REVISIONS_KEPT + 5; i++) {
      const o = object(db, `repo_file:f${i}.ts@h1`);
      applyManifestDelta(db, 't1', { add: { workingSet: [o.ref] } });
    }
    expect(getManifest(db, 't1')?.revision).toBe(MANIFEST_REVISIONS_KEPT + 5);
    expect(getManifest(db, 't1')?.workingSet).toHaveLength(MANIFEST_REVISIONS_KEPT + 5);
  });

  it('keeps each task apart', () => {
    const db = createDb(TEST_DB);
    const a = object(db, 'repo_file:a.ts@h1');
    applyManifestDelta(db, 't1', { add: { workingSet: [a.ref] } });
    expect(getManifest(db, 't2')).toBeNull();
  });
});
