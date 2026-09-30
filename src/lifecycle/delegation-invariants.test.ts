/** The invariants of hierarchical work ownership, stated once, against the
 *  production wiring (durable ledger, real git workspaces, real event log). Each
 *  block is one sentence of docs/architecture/hierarchical-work-ownership-acceptance.md
 *  that must stay true however the internals are refactored. */
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { existsSync, unlinkSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '../db/client.js';
import { getNode, insertNode, listNodes } from '../db/queries/nodes.js';
import { listDelegationsForParent } from '../db/queries/delegations.js';
import { delegateToChildren, MAX_REWORK_REVISIONS, type DelegateChildDeps } from './delegate-child.js';
import { realDelegateDeps, mergeAcceptedDelegation } from './node-actor-manager.js';
import { delegationEventsFor, openDelegation, transitionDelegation } from './delegation-events.js';
import { canTransitionDelegation, DELEGATION_STATUSES, IllegalDelegationTransitionError } from '../schemas/delegation.js';
import type { ChildRunResult } from './delegation-review.js';

process.env.ORG_FORKS_ROOT = mkdtempSync(join(homedir(), '.org-forks-invariants-test-'));
afterAll(() => rmSync(process.env.ORG_FORKS_ROOT!, { recursive: true, force: true }));

const TEST_DB = './test-delegation-invariants.db';
const made: string[] = [];
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
  for (const dir of made.splice(0)) {
    try { execFileSync('git', ['worktree', 'prune'], { cwd: dir, stdio: 'ignore' }); } catch { /* best effort */ }
  }
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const PASS = { id: 'observed:npm test', command: 'npm test', passed: true };
const CONTRACT = (goal: string, budget = 8, children = 8) => ({
  goal, definition_of_done: ['done'],
  authority: { tools: [] as string[], spawn_children: true, max_child_count: children, budget_usd: budget }, constraints: [] as string[],
});

function setup(budget = 8) {
  const db = createDb(TEST_DB);
  const base = mkdtempSync(join(tmpdir(), 'invariants-base-'));
  made.push(base);
  writeFileSync(join(base, 'README.md'), 'hello\n');
  git(base, 'init', '-q'); git(base, 'config', 'user.email', 't@e.com'); git(base, 'config', 'user.name', 't');
  git(base, 'add', '-A'); git(base, 'commit', '-qm', 'first');
  insertNode(db, {
    id: 'root', parentId: null, goal: 'root', state: 'DELEGATE', repoPath: base,
    contract: CONTRACT('root', budget), createdAt: 't0', updatedAt: 't0',
  });
  return { db, base };
}

/** deps whose children are simulated by `work`; everything else is production. */
function simulated(
  db: ReturnType<typeof createDb>, parentId: string,
  work: (childId: string, goal: string, dispatch: number, workspace: string | undefined) => Promise<Partial<ChildRunResult> & { writes?: Record<string, string> }>,
  extra: Partial<DelegateChildDeps> = {},
) {
  const real = realDelegateDeps(db, parentId);
  const dispatches = new Map<string, number>();
  const running = new Map<string, { goal: string; dispatch: number }>();
  const started: string[] = [];
  const deps: DelegateChildDeps = {
    ...real,
    startChild: (childId, goal) => {
      const dispatch = (dispatches.get(childId) ?? 0) + 1;
      dispatches.set(childId, dispatch);
      running.set(childId, { goal, dispatch });
      started.push(childId);
    },
    waitForChild: async (childId) => {
      const job = running.get(childId)!;
      const workspace = real.describeChild!(childId)?.workspace?.path;
      const { writes, ...result } = await work(childId, job.goal, job.dispatch, workspace);
      for (const [file, content] of Object.entries(writes ?? {})) writeFileSync(join(workspace ?? '/nonexistent', file), content);
      return { succeeded: true, changedFiles: Object.keys(writes ?? {}), answer: 'done', ...result };
    },
    ...extra,
  };
  return { deps, started };
}

describe('invariant: acceptance before merge', () => {
  it('no status change can reach MERGING except from ACCEPTED (or a blocked-merge retry)', () => {
    for (const from of DELEGATION_STATUSES) {
      const allowed = canTransitionDelegation(from, 'MERGING');
      expect(allowed).toBe(from === 'ACCEPTED' || from === 'INTEGRATION_BLOCKED');
    }
  });

  it('a child that finished cannot be merged by anyone, only accepted work can', () => {
    const { db, base } = setup();
    insertNode(db, { id: 'kid', parentId: 'root', goal: 'k', state: 'COMPLETE', repoPath: base, contract: CONTRACT('k'), createdAt: 't', updatedAt: 't' });
    openDelegation(db, { id: 'a', parentId: 'root', childId: 'kid', goal: 'k', definitionOfDone: ['d'], acceptanceChecks: [], dependencies: [], budgetUsd: 1 }, 't');
    transitionDelegation(db, 'a', 'WORKING', {}, 't');
    transitionDelegation(db, 'a', 'REPORT_READY', {}, 't');
    expect(() => mergeAcceptedDelegation(db, 'a')).toThrow(IllegalDelegationTransitionError);
  });

  it('unaccepted work never reaches the tree, however the run ends', async () => {
    const { db, base } = setup();
    const { deps } = simulated(db, 'root', async () => ({ writes: { 'x.ts': 'unreviewed\n' }, observedChecks: [] }));
    await delegateToChildren({ parentId: 'root', goal: 'g', subgoals: ['build x'], acceptanceChecks: ['npm test'] }, deps);
    expect(existsSync(join(base, 'x.ts'))).toBe(false);
    expect(git(base, 'status', '--porcelain')).toBe('');
  });
});

describe('invariant: failed acceptance means rework by the same child', () => {
  it('one node, one assignment, one workspace, however many revisions', async () => {
    const { db } = setup();
    const workspaces = new Set<string | undefined>();
    const { deps, started } = simulated(db, 'root', async (_id, _goal, dispatch, workspace) => {
      workspaces.add(workspace);
      return dispatch <= MAX_REWORK_REVISIONS
        ? { writes: { 'x.ts': `attempt ${dispatch}\n` }, observedChecks: [] }
        : { writes: { 'x.ts': 'good\n' }, observedChecks: [PASS] };
    });
    const result = await delegateToChildren({ parentId: 'root', goal: 'g', subgoals: ['build x'], acceptanceChecks: ['npm test'] }, deps);
    expect(result.succeeded).toBe(true);
    expect(new Set(started).size).toBe(1);
    expect(started).toHaveLength(MAX_REWORK_REVISIONS + 1);
    expect(workspaces.size).toBe(1);
    expect(listDelegationsForParent(db, 'root')).toHaveLength(1);
    expect(listNodes(db).filter((n) => n.parentId === 'root')).toHaveLength(1);
  });
});

describe('invariant: isolation', () => {
  it('a failed review leaves its worktree on disk and the parent tree untouched', async () => {
    const { db, base } = setup();
    const { deps } = simulated(db, 'root', async () => ({ writes: { 'x.ts': 'nope\n' }, observedChecks: [] }));
    await delegateToChildren({ parentId: 'root', goal: 'g', subgoals: ['build x'], acceptanceChecks: ['npm test'] }, deps);
    const [record] = listDelegationsForParent(db, 'root');
    expect(record.status).toBe('ESCALATED');
    expect(existsSync(join(record.workspace!.path, 'x.ts'))).toBe(true);
    expect(existsSync(join(base, 'x.ts'))).toBe(false);
  });
});

describe('invariant: reassignment is explicit', () => {
  it('the same failures without a decision never produce a second child', async () => {
    const { db } = setup();
    const { deps } = simulated(db, 'root', async () => ({ writes: { 'x.ts': 'nope\n' }, observedChecks: [] }));
    await delegateToChildren({ parentId: 'root', goal: 'g', subgoals: ['build x'], acceptanceChecks: ['npm test'] }, deps);
    expect(listNodes(db).filter((n) => n.parentId === 'root')).toHaveLength(1);
    expect(delegationEventsFor(db, 'root').some((e) => e.type === 'delegation.reassigned')).toBe(false);
  });
});

describe('invariant: authority and budget boundaries', () => {
  it('a reassigned child is capped at what its predecessor had left', async () => {
    const { db } = setup(4);
    let first: string | undefined;
    const { deps } = simulated(db, 'root', async (childId) => {
      first ??= childId;
      return childId === first
        ? { writes: { 'x.ts': 'nope\n' }, observedChecks: [] }
        : { writes: { 'x.ts': 'ok\n' }, observedChecks: [PASS] };
    }, {
      decideRecovery: async () => ({ action: 'reassign', reason: 'needs a fresh start', decidedBy: 'human:test' }),
    });
    await delegateToChildren({ parentId: 'root', goal: 'g', subgoals: ['build x'], acceptanceChecks: ['npm test'] }, deps);
    const [old, successor] = listDelegationsForParent(db, 'root');
    expect(successor.budgetUsd).toBeLessThanOrEqual(old.budgetUsd);
    expect(getNode(db, successor.childId)!.contract.authority.budget_usd).toBeLessThanOrEqual(getNode(db, old.childId)!.contract.authority.budget_usd);
    expect(getNode(db, successor.childId)!.contract.authority.max_child_count).toBeLessThanOrEqual(getNode(db, old.childId)!.contract.authority.max_child_count);
  });

  it('will not fund another revision the child can no longer afford', async () => {
    // Two children split $0.6 with the parent's own share held back: $0.2 each,
    // under the minimum an agent needs. The parent stops and asks instead of
    // spending money the split did not allocate.
    const { db } = setup(0.6);
    const { deps, started } = simulated(db, 'root', async () => ({ writes: {}, observedChecks: [] }));
    await delegateToChildren({ parentId: 'root', goal: 'g', subgoals: ['build x', 'build y'], acceptanceChecks: ['npm test'] }, deps);
    expect(started).toHaveLength(2); // each child ran once; nobody was sent back
    expect(listDelegationsForParent(db, 'root').map((r) => r.status)).toEqual(['ESCALATED', 'ESCALATED']);
  });
});

describe('invariant: evidence is retained', () => {
  it('every revision leaves its report and feedback in the audit trail', async () => {
    const { db } = setup();
    const { deps } = simulated(db, 'root', async (_id, _goal, dispatch) => ({
      writes: { 'x.ts': `${dispatch}\n` }, observedChecks: [], answer: `revision ${dispatch} report`,
    }));
    await delegateToChildren({ parentId: 'root', goal: 'g', subgoals: ['build x'], acceptanceChecks: ['npm test'] }, deps);
    const events = delegationEventsFor(db, 'root');
    const feedbacks = events.filter((e) => e.type === 'delegation.feedback_required');
    expect(feedbacks).toHaveLength(MAX_REWORK_REVISIONS + 1);
    for (const event of feedbacks) {
      expect((event.payload as { failedChecks: string[] }).failedChecks).toEqual(['npm test']);
    }
    const record = listDelegationsForParent(db, 'root')[0];
    expect(record.report?.summary).toBe(`revision ${MAX_REWORK_REVISIONS + 1} report`);
    expect(record.feedbackHistory).toHaveLength(MAX_REWORK_REVISIONS);
  });
});

describe('invariant: delegation is recursive', () => {
  it('a child can become a parent: its own children are assigned, reviewed and merged into its workspace, and it is then reviewed itself', async () => {
    const { db, base } = setup();

    // The outer piece's "work" is itself a delegation, run by the child as the
    // parent of two grandchildren — the same model, one level down.
    const { deps: outer } = simulated(db, 'root', async (childId, _goal, _dispatch, workspace) => {
      const inner = simulated(db, childId, async (_gc, goal) => ({
        writes: { [`${goal.includes('left') ? 'left' : 'right'}.ts`]: 'export {};\n' }, observedChecks: [PASS],
      }));
      const nested = await delegateToChildren({
        parentId: childId, goal: 'inner', subgoals: ['build left', 'build right'], acceptanceChecks: ['npm test passes'],
      }, inner.deps);
      // The grandchildren's accepted work landed in the *child's* workspace, not the root's.
      expect(nested.succeeded).toBe(true);
      expect(existsSync(join(workspace!, 'left.ts'))).toBe(true);
      expect(existsSync(join(base, 'left.ts'))).toBe(false);
      return { writes: { 'child.ts': 'export {};\n' }, observedChecks: [PASS] };
    });

    const result = await delegateToChildren({
      parentId: 'root', goal: 'g', subgoals: ['build the whole thing'], acceptanceChecks: ['npm test passes'],
    }, outer);

    expect(result.succeeded).toBe(true);
    // Merged upward: grandchildren → child's workspace → root's tree.
    for (const file of ['left.ts', 'right.ts', 'child.ts']) expect(existsSync(join(base, file))).toBe(true);

    const [childAssignment] = listDelegationsForParent(db, 'root');
    expect(childAssignment.status).toBe('MERGED');
    const grandAssignments = listDelegationsForParent(db, childAssignment.childId);
    expect(grandAssignments.map((a) => a.status)).toEqual(['MERGED', 'MERGED']);
    expect(grandAssignments.every((a) => a.parentId === childAssignment.childId)).toBe(true);
    // Each level's assignments are audited on its own parent.
    expect(delegationEventsFor(db, childAssignment.childId).some((e) => e.type === 'delegation.merged')).toBe(true);
    // The child's authority bounds its own children, exactly as the root's bounded it.
    const childAuthority = getNode(db, childAssignment.childId)!.contract.authority;
    for (const grand of grandAssignments) {
      expect(grand.budgetUsd).toBeLessThanOrEqual(childAuthority.budget_usd);
    }
    expect(readFileSync(join(base, 'child.ts'), 'utf8')).toBe('export {};\n');
  });
});
