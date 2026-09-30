import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { existsSync, unlinkSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '../db/client.js';
import { getNode, insertNode } from '../db/queries/nodes.js';
import { getDelegation } from '../db/queries/delegations.js';
import { IllegalDelegationTransitionError } from '../schemas/delegation.js';
import { forkWorkspace, type WorkspaceFork } from '../execution/workspace-fork.js';
import { mergeAcceptedDelegation } from './node-actor-manager.js';
import { openDelegation, transitionDelegation, delegationEventsFor } from './delegation-events.js';

process.env.ORG_FORKS_ROOT = mkdtempSync(join(homedir(), '.org-forks-merge-test-'));
afterAll(() => rmSync(process.env.ORG_FORKS_ROOT!, { recursive: true, force: true }));

const TEST_DB = './test-delegation-merge.db';
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
  const path = mkdtempSync(join(tmpdir(), 'merge-base-'));
  made.push(path);
  writeFileSync(join(path, 'a.ts'), 'export const a = 1;\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@e.com'); git('config', 'user.name', 't');
  git('add', '-A'); git('commit', '-qm', 'first');
  return path;
}

const gitOut = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

/** A parent, a child whose fork has written `a.ts`, and an assignment in the given state. */
function setup(fork: WorkspaceFork | null, upTo: 'ASSIGNED' | 'REPORT_READY' | 'UNDER_REVIEW' | 'ACCEPTED') {
  const db = createDb(TEST_DB);
  const contract = (goal: string) => ({
    goal, definition_of_done: ['done'],
    authority: { tools: [] as string[], spawn_children: true, max_child_count: 4, budget_usd: 1 }, constraints: [] as string[],
  });
  insertNode(db, { id: 'p', parentId: null, goal: 'parent', contract: contract('parent'), state: 'DELEGATE', repoPath: fork?.basePath ?? '/x', createdAt: 't0', updatedAt: 't0' });
  insertNode(db, { id: 'c1', parentId: 'p', goal: 'child', contract: contract('child'), state: 'COMPLETE', repoPath: fork?.path ?? '/x', createdAt: 't0', updatedAt: 't0' });
  openDelegation(db, {
    id: 'a1', parentId: 'p', childId: 'c1', goal: 'child', definitionOfDone: ['done'],
    acceptanceChecks: [], dependencies: [], budgetUsd: 1,
    ...(fork ? { workspace: { path: fork.path, basePath: fork.basePath, revision: fork.revision } } : {}),
  }, 't1');
  const path: Array<'WORKING' | 'REPORT_READY' | 'UNDER_REVIEW' | 'ACCEPTED'> = ['WORKING', 'REPORT_READY', 'UNDER_REVIEW', 'ACCEPTED'];
  for (const status of path.slice(0, upTo === 'ASSIGNED' ? 0 : path.indexOf(upTo) + 1)) {
    transitionDelegation(db, 'a1', status, {}, 't2');
  }
  return db;
}

describe('mergeAcceptedDelegation', () => {
  it('will not merge a child that was never reviewed, even though its node is COMPLETE', () => {
    const base = repo();
    const fork = forkWorkspace(base, 'HEAD', 'c1')!;
    writeFileSync(join(fork.path, 'new.ts'), 'export const n = 1;\n');
    const db = setup(fork, 'REPORT_READY');

    expect(getNode(db, 'c1')?.state).toBe('COMPLETE'); // execution finished…
    expect(() => mergeAcceptedDelegation(db, 'a1')).toThrow(IllegalDelegationTransitionError); // …that is not acceptance
    expect(existsSync(join(base, 'new.ts'))).toBe(false);
    expect(existsSync(fork.path)).toBe(true);
    expect(getDelegation(db, 'a1')?.status).toBe('REPORT_READY');
    fork.release();
  });

  it('will not merge while a review is still open', () => {
    const base = repo();
    const fork = forkWorkspace(base, 'HEAD', 'c1')!;
    writeFileSync(join(fork.path, 'new.ts'), 'x\n');
    const db = setup(fork, 'UNDER_REVIEW');
    expect(() => mergeAcceptedDelegation(db, 'a1')).toThrow(IllegalDelegationTransitionError);
    expect(existsSync(join(base, 'new.ts'))).toBe(false);
    fork.release();
  });

  it('merges an accepted child: ACCEPTED → MERGING → MERGED, the tree gets the work, the fork is released', () => {
    const base = repo();
    const fork = forkWorkspace(base, 'HEAD', 'c1')!;
    writeFileSync(join(fork.path, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(fork.path, 'new.ts'), 'export const n = 1;\n');
    const db = setup(fork, 'ACCEPTED');

    expect(mergeAcceptedDelegation(db, 'a1')).toBe('MERGED');
    expect(getDelegation(db, 'a1')?.status).toBe('MERGED');
    expect(readFileSync(join(base, 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(readFileSync(join(base, 'new.ts'), 'utf8')).toBe('export const n = 1;\n');
    expect(existsSync(fork.path)).toBe(false);
    expect(delegationEventsFor(db, 'p').map((e) => e.type).slice(-3))
      .toEqual(['delegation.accepted', 'delegation.merging', 'delegation.merged']);
  });

  it('an accepted child whose merge conflicts is INTEGRATION_BLOCKED: base untouched, fork kept, child not failed', () => {
    const base = repo();
    const fork = forkWorkspace(base, 'HEAD', 'c1')!;
    writeFileSync(join(fork.path, 'a.ts'), 'export const a = "child";\n');
    writeFileSync(join(base, 'a.ts'), 'export const a = "parent moved on";\n');
    execFileSync('git', ['add', '-A'], { cwd: base });
    execFileSync('git', ['commit', '-qm', 'parent moved'], { cwd: base, stdio: 'ignore' });
    const db = setup(fork, 'ACCEPTED');
    const before = gitOut(base, 'status', '--porcelain');

    expect(mergeAcceptedDelegation(db, 'a1')).toBe('INTEGRATION_BLOCKED');

    const record = getDelegation(db, 'a1')!;
    expect(record.status).toBe('INTEGRATION_BLOCKED');
    // A conflict is not an implementation failure: nothing reopened, nothing failed.
    expect(getNode(db, 'c1')?.state).toBe('COMPLETE');
    expect(gitOut(base, 'status', '--porcelain')).toBe(before);
    expect(readFileSync(join(base, 'a.ts'), 'utf8')).toContain('parent moved on');
    // The candidate is still there to inspect, retry or rework.
    expect(existsSync(fork.path)).toBe(true);
    expect(readFileSync(join(fork.path, 'a.ts'), 'utf8')).toContain('child');
    expect(delegationEventsFor(db, 'p').at(-1)).toMatchObject({
      type: 'delegation.integration_blocked', payload: { assignmentId: 'a1', childId: 'c1', from: 'MERGING' },
    });
    fork.release();
  });

  it('can be retried from INTEGRATION_BLOCKED once the conflict is gone', () => {
    const base = repo();
    const fork = forkWorkspace(base, 'HEAD', 'c1')!;
    writeFileSync(join(fork.path, 'a.ts'), 'export const a = "child";\n');
    writeFileSync(join(base, 'a.ts'), 'export const a = "parent";\n');
    execFileSync('git', ['add', '-A'], { cwd: base });
    execFileSync('git', ['commit', '-qm', 'parent moved'], { cwd: base, stdio: 'ignore' });
    const db = setup(fork, 'ACCEPTED');
    expect(mergeAcceptedDelegation(db, 'a1')).toBe('INTEGRATION_BLOCKED');

    // The parent resolves it on its side: its copy goes back to what the child forked from.
    execFileSync('git', ['revert', '--no-edit', 'HEAD'], { cwd: base, stdio: 'ignore' });
    expect(mergeAcceptedDelegation(db, 'a1')).toBe('MERGED');
    expect(readFileSync(join(base, 'a.ts'), 'utf8')).toBe('export const a = "child";\n');
    expect(getDelegation(db, 'a1')?.status).toBe('MERGED');
  });

  it('has nothing to integrate for a child that shared its parent\'s tree, and is still merged only once accepted', () => {
    const acceptedDb = setup(null, 'ACCEPTED');
    expect(mergeAcceptedDelegation(acceptedDb, 'a1')).toBe('MERGED');
  });

  it('refuses an unknown assignment', () => {
    const db = createDb(TEST_DB);
    expect(() => mergeAcceptedDelegation(db, 'nope')).toThrow(/does not exist/);
  });
});
