import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { existsSync, unlinkSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '../db/client.js';
import { getNode, insertNode } from '../db/queries/nodes.js';
import { realDelegateDeps, integrateFork, childRunResult } from './node-actor-manager.js';
import { forkWorkspace } from '../execution/workspace-fork.js';

// This file's forks live in a directory of their own: a server test running in
// parallel sweeps orphaned forks out of the shared default root at startup, and
// would delete these mid-test. Under $HOME, because only home is visible to
// the cluster.
process.env.ORG_FORKS_ROOT = mkdtempSync(join(homedir(), '.org-forks-test-'));
afterAll(() => rmSync(process.env.ORG_FORKS_ROOT!, { recursive: true, force: true }));

// Two failure modes this closes, both real and both observed: a benchmark run
// that left 85 files of cross-goal contamination in the live working tree
// (docs/benchmarks/2026-09-17-real-paid-benchmark-results.md §4), and
// `delegateToChildren` handing every sibling `parent.repoPath` directly with
// no isolation at all (confirmed by source inspection — no fork, no snapshot,
// same directory for every write-capable child).

const TEST_DB = './test-fork-isolation.db';
const made: string[] = [];

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
  for (const dir of made.splice(0)) {
    try { execFileSync('git', ['worktree', 'prune'], { cwd: dir, stdio: 'ignore' }); } catch { /* best effort */ }
  }
});

function repo(): string {
  const path = mkdtempSync(join(tmpdir(), 'delegate-base-'));
  made.push(path);
  writeFileSync(join(path, 'a.ts'), 'export const a = 1;\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-qm', 'first');
  return path;
}

const WRITE_CONTRACT = (goal: string) => ({
  goal, definition_of_done: ['done'],
  authority: { tools: [] as string[], spawn_children: true, max_child_count: 4, budget_usd: 1 }, constraints: [] as string[],
});

describe('delegated children and repository isolation', () => {
  it('gives each write-capable sibling its own forked worktree, not the parent path', () => {
    const db = createDb(TEST_DB);
    const base = repo();
    insertNode(db, {
      id: 'parent', parentId: null, goal: 'split this', contract: WRITE_CONTRACT('split this'),
      state: 'CREATED', repoPath: base, createdAt: 't0', updatedAt: 't0',
    });

    const deps = realDelegateDeps(db);
    const child1 = deps.createChildNode('parent', 'do part one', 2);
    const child2 = deps.createChildNode('parent', 'do part two', 2);

    const node1 = getNode(db, child1);
    const node2 = getNode(db, child2);

    expect(node1?.repoPath).not.toBe(base);
    expect(node2?.repoPath).not.toBe(base);
    expect(node1?.repoPath).not.toBe(node2?.repoPath);
    expect(existsSync(node1!.repoPath!)).toBe(true);
    expect(existsSync(node2!.repoPath!)).toBe(true);

    // The base is untouched by fork creation alone — isolation, not a copy
    // that happens to diverge later.
    expect(readFileSync(join(base, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  // Replaces "shares the parent path for a single child, where there is nothing
  // to race with". Racing was never the only reason to isolate: the parent now
  // reviews a child's candidate before accepting it, and a lone child editing
  // the parent's tree directly has already merged before anyone looked.
  it('gives a lone write-capable child its own fork too, so its work is a candidate until accepted', () => {
    const db = createDb(TEST_DB);
    const base = repo();
    insertNode(db, {
      id: 'parent', parentId: null, goal: 'do this', contract: WRITE_CONTRACT('do this'),
      state: 'CREATED', repoPath: base, createdAt: 't0', updatedAt: 't0',
    });

    const deps = realDelegateDeps(db);
    const onlyChild = deps.createChildNode('parent', 'the whole thing', 1);
    expect(getNode(db, onlyChild)?.repoPath).not.toBe(base);
    const workspace = deps.describeChild!(onlyChild)!.workspace!;
    expect(existsSync(workspace.path)).toBe(true);
    expect(workspace.basePath).toBe(base);
  });

  it('shares the parent path for a read-only sibling, which cannot corrupt anything', () => {
    const db = createDb(TEST_DB);
    const base = repo();
    const readOnlyContract = {
      ...WRITE_CONTRACT('inspect this'),
      authority: { tools: ['Read', 'Grep'] as string[], spawn_children: true, max_child_count: 4, budget_usd: 1 },
    };
    insertNode(db, {
      id: 'parent', parentId: null, goal: 'inspect this', contract: readOnlyContract,
      state: 'CREATED', repoPath: base, createdAt: 't0', updatedAt: 't0',
    });

    const deps = realDelegateDeps(db);
    const child = deps.createChildNode('parent', 'look at part one', 2);
    expect(getNode(db, child)?.repoPath).toBe(base);
  });
});

describe('integrating a fork back onto its base', () => {
  it('applies a forked child\'s writes onto the base it forked from', () => {
    const base = repo();
    const fork = forkWorkspace(base, 'HEAD', 'child-1')!;
    writeFileSync(join(fork.path, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(fork.path, 'new.ts'), 'export const brandNew = true;\n');

    expect(integrateFork(fork)).toBe(true);
    expect(readFileSync(join(base, 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(readFileSync(join(base, 'new.ts'), 'utf8')).toBe('export const brandNew = true;\n');
    fork.release();
  });

  it('integrates two siblings\' non-overlapping writes in sequence', () => {
    const base = repo();
    const first = forkWorkspace(base, 'HEAD', 'child-1')!;
    const second = forkWorkspace(base, 'HEAD', 'child-2')!;
    writeFileSync(join(first.path, 'first.ts'), 'export const first = true;\n');
    writeFileSync(join(second.path, 'second.ts'), 'export const second = true;\n');

    expect(integrateFork(first)).toBe(true);
    expect(integrateFork(second)).toBe(true);
    expect(existsSync(join(base, 'first.ts'))).toBe(true);
    expect(existsSync(join(base, 'second.ts'))).toBe(true);
    first.release();
    second.release();
  });

  it('fails the second integration rather than silently clobbering the first sibling\'s conflicting write', () => {
    const base = repo();
    const first = forkWorkspace(base, 'HEAD', 'child-1')!;
    const second = forkWorkspace(base, 'HEAD', 'child-2')!;
    writeFileSync(join(first.path, 'a.ts'), 'export const a = "from first";\n');
    writeFileSync(join(second.path, 'a.ts'), 'export const a = "from second, on the same line";\n');

    expect(integrateFork(first)).toBe(true);
    expect(integrateFork(second)).toBe(false);

    // The winner is whichever integrated first, stated and checkable — not an
    // unattributed race between two sandboxes writing the same checkout.
    expect(readFileSync(join(base, 'a.ts'), 'utf8')).toContain('from first');
    first.release();
    second.release();
  });

  it('leaves the base exactly as it was when a real three-way conflict is refused', () => {
    // A conflict that git *can* attempt (the base's copy is committed, so the
    // 3-way merge runs) used to leave conflict markers and unmerged index
    // entries in the authoritative tree while reporting only `false`. A blocked
    // integration must not have touched what it was blocked from.
    const base = repo();
    const fork = forkWorkspace(base, 'HEAD', 'child-1')!;
    writeFileSync(join(fork.path, 'a.ts'), 'export const a = "from the child";\n');
    writeFileSync(join(fork.path, 'brand-new.ts'), 'export const fresh = true;\n');

    const git = (...args: string[]) => execFileSync('git', args, { cwd: base, encoding: 'utf8' });
    writeFileSync(join(base, 'a.ts'), 'export const a = "from the parent";\n');
    git('add', '-A');
    git('commit', '-qm', 'parent moved on');
    const before = { status: git('status', '--porcelain'), a: readFileSync(join(base, 'a.ts'), 'utf8') };

    expect(integrateFork(fork)).toBe(false);

    expect(git('status', '--porcelain')).toBe(before.status);
    expect(readFileSync(join(base, 'a.ts'), 'utf8')).toBe(before.a);
    expect(readFileSync(join(base, 'a.ts'), 'utf8')).not.toContain('<<<<<<<');
    // Nothing from the refused change leaked in beside the conflict either.
    expect(existsSync(join(base, 'brand-new.ts'))).toBe(false);
    expect(git('ls-files', '-u')).toBe('');
    // The child's candidate is untouched, so it can still be reworked or retried.
    expect(readFileSync(join(fork.path, 'a.ts'), 'utf8')).toContain('from the child');
    fork.release();
  });

  it('is a no-op when the fork wrote nothing', () => {
    const base = repo();
    const fork = forkWorkspace(base, 'HEAD', 'child-1')!;
    expect(integrateFork(fork)).toBe(true);
    fork.release();
  });
});

// Replaces "a child that did not pass still hands its work back to the task
// tree". That test asserted the old `settleFork` behaviour — integrate a fork the
// moment its child finished, passed or not. That is intentionally gone: only work
// the parent has *accepted* may reach the parent's tree (see
// delegation-merge.test.ts), and a child finishing is only a report.
describe('a child that finished', () => {
  it('leaves its work in its own workspace until the parent accepts it', () => {
    const db = createDb(TEST_DB);
    const base = repo();
    insertNode(db, {
      id: 'parent', parentId: null, goal: 'split this', contract: WRITE_CONTRACT('split this'),
      state: 'CREATED', repoPath: base, createdAt: 't0', updatedAt: 't0',
    });
    const deps = realDelegateDeps(db, 'parent');
    const childId = deps.createChildNode('parent', 'do part one', 2);
    const workspace = deps.describeChild!(childId)!.workspace!;
    writeFileSync(join(workspace.path, 'backend.py'), 'app = "built but not validated"\n');

    // What waiting for the child reports: execution over, nothing integrated.
    const result = childRunResult(db, childId, { succeeded: false });

    expect(result.succeeded).toBe(false);
    expect(existsSync(join(base, 'backend.py'))).toBe(false);
    expect(existsSync(workspace.path)).toBe(true);
  });
});

describe('a fork sees the tree the run sees, not just HEAD', () => {
  it('carries the base\'s uncommitted work, and integrates only the child\'s own', () => {
    // A piece ordered after another forks once the earlier one is integrated —
    // uncommitted. Forked from HEAD alone it never saw the research it was
    // waiting for.
    const base = repo();
    writeFileSync(join(base, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(base, 'notes.md'), 'research from an earlier piece\n');

    const fork = forkWorkspace(base, 'HEAD', 'dependent-child')!;
    expect(readFileSync(join(fork.path, 'notes.md'), 'utf8')).toBe('research from an earlier piece\n');
    expect(readFileSync(join(fork.path, 'a.ts'), 'utf8')).toBe('export const a = 2;\n');

    writeFileSync(join(fork.path, 'page.html'), '<h1>built from the notes</h1>\n');
    expect(integrateFork(fork)).toBe(true);
    expect(readFileSync(join(base, 'page.html'), 'utf8')).toBe('<h1>built from the notes</h1>\n');
    expect(readFileSync(join(base, 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
    // The base's own index is untouched: notes.md is still untracked there.
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: base, encoding: 'utf8' })).toContain('?? notes.md');
    fork.release();
  });
});
