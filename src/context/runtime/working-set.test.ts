import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../../db/client.js';
import { putContextObject, markFreshness, getLatest } from '../store.js';
import { scopeOf } from '../types.js';
import { getManifest } from './task-context-manifest.js';
import { recordWorkingSet, projectWorkingSet, repoFileId, parseRepoFileId } from './working-set.js';

const TEST_DB = './test-working-set.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const readOnly = scopeOf(['Read', 'Grep'], true);
const writer = scopeOf(null, false);

describe('repo file identity carries the revision it was recorded against', () => {
  it('round-trips path, revision and scope, even for a path containing @', () => {
    const id = repoFileId('node_modules/@types/x/index.d.ts', 'abc123', readOnly);
    const parsed = parseRepoFileId(id);
    expect(parsed).toMatchObject({ path: 'node_modules/@types/x/index.d.ts', revision: 'abc123' });
    expect(parseRepoFileId('observation:Bash:zzz')).toBeNull();
  });

  it('gives different scopes different identities, so neither clobbers the other', () => {
    expect(repoFileId('a.ts', 'r1', readOnly)).not.toBe(repoFileId('a.ts', 'r1', writer));
    expect(repoFileId('a.ts', 'r1', readOnly)).toBe(repoFileId('a.ts', 'r1', scopeOf(['Grep', 'Read'], true)));
  });
});

describe('sharing what siblings were shown', () => {
  it('lets sibling B resolve the paths sibling A recorded, and nothing more', () => {
    const db = createDb(TEST_DB);
    recordWorkingSet(db, 'task', { revision: 'r1', scope: readOnly, paths: [{ path: 'src/a.ts', tokens: 40 }, { path: 'src/b.ts', tokens: 90 }] });
    const seen = projectWorkingSet(db, 'task', { revision: 'r1', scope: readOnly });
    expect(seen.paths).toEqual(['src/a.ts', 'src/b.ts']);
    // References and paths: no file content is ever injected by this.
    expect(JSON.stringify(seen)).not.toMatch(/export |function /);
  });

  it('is deterministic and de-duplicated however many siblings recorded the same file', () => {
    const db = createDb(TEST_DB);
    recordWorkingSet(db, 'task', { revision: 'r1', scope: readOnly, paths: [{ path: 'b.ts' }, { path: 'a.ts' }] });
    recordWorkingSet(db, 'task', { revision: 'r1', scope: readOnly, paths: [{ path: 'a.ts' }, { path: 'c.ts' }] });
    expect(projectWorkingSet(db, 'task', { revision: 'r1', scope: readOnly }).paths).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(getManifest(db, 'task')!.workingSet).toHaveLength(3);
  });

  it('moves the manifest revision once per batch, and not at all for a repeat', () => {
    const db = createDb(TEST_DB);
    recordWorkingSet(db, 'task', { revision: 'r1', scope: readOnly, paths: [{ path: 'a.ts' }, { path: 'b.ts' }] });
    expect(getManifest(db, 'task')!.revision).toBe(1);
    recordWorkingSet(db, 'task', { revision: 'r1', scope: readOnly, paths: [{ path: 'a.ts' }] });
    expect(getManifest(db, 'task')!.revision).toBe(1);
  });
});

describe('what must not be shared', () => {
  it('never offers a file recorded at another repository revision', () => {
    const db = createDb(TEST_DB);
    recordWorkingSet(db, 'task', { revision: 'r1', scope: readOnly, paths: [{ path: 'a.ts' }] });
    const later = projectWorkingSet(db, 'task', { revision: 'r2', scope: readOnly });
    expect(later.paths).toEqual([]);
    expect(later.excluded.map((e) => e.reason)).toEqual(['other_revision']);
  });

  it('never hands a narrower consumer what a broader scope produced', () => {
    const db = createDb(TEST_DB);
    recordWorkingSet(db, 'task', { revision: 'r1', scope: writer, paths: [{ path: 'secret-plan.ts' }] });
    const narrow = projectWorkingSet(db, 'task', { revision: 'r1', scope: readOnly });
    expect(narrow.paths).toEqual([]);
    expect(narrow.excluded.map((e) => e.reason)).toEqual(['scope']);
  });

  it('does allow a wider consumer to reuse what a narrower one saw', () => {
    const db = createDb(TEST_DB);
    const narrow = scopeOf(['Read'], false);
    recordWorkingSet(db, 'task', { revision: 'r1', scope: narrow, paths: [{ path: 'a.ts' }] });
    expect(projectWorkingSet(db, 'task', { revision: 'r1', scope: scopeOf(null, false) }).paths).toEqual(['a.ts']);
  });

  it('skips a ref whose object has since been marked wrong', () => {
    const db = createDb(TEST_DB);
    recordWorkingSet(db, 'task', { revision: 'r1', scope: readOnly, paths: [{ path: 'a.ts' }, { path: 'b.ts' }] });
    const id = repoFileId('a.ts', 'r1', readOnly);
    markFreshness(db, getLatest(db, id)!.ref, 'INVALID');
    const seen = projectWorkingSet(db, 'task', { revision: 'r1', scope: readOnly });
    expect(seen.paths).toEqual(['b.ts']);
    expect(seen.excluded[0].reason).toBe('not_valid');
  });

  it('keeps one task from seeing another task’s working set', () => {
    const db = createDb(TEST_DB);
    recordWorkingSet(db, 'task-1', { revision: 'r1', scope: readOnly, paths: [{ path: 'a.ts' }] });
    expect(projectWorkingSet(db, 'task-2', { revision: 'r1', scope: readOnly }).paths).toEqual([]);
  });

  it('has nothing to offer a task that recorded nothing, without throwing', () => {
    expect(projectWorkingSet(createDb(TEST_DB), 'nobody', { revision: 'r1', scope: readOnly }).paths).toEqual([]);
  });

  it('ignores manifest entries that are not repository files', () => {
    const db = createDb(TEST_DB);
    recordWorkingSet(db, 'task', { revision: 'r1', scope: readOnly, paths: [{ path: 'a.ts' }] });
    const obs = putContextObject(db, { semanticId: 'observation:Bash:1', kind: 'observation', content: 'ok', source: { kind: 'inline', locator: 'x' }, scope: readOnly });
    expect(obs.ref.semanticId).toBe('observation:Bash:1');
    expect(projectWorkingSet(db, 'task', { revision: 'r1', scope: readOnly }).paths).toEqual(['a.ts']);
  });
});
