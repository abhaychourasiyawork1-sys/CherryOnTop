import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { existsSync, unlinkSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createDb, type Db } from '../db/client.js';
import { getNode, insertNode, listNodes } from '../db/queries/nodes.js';
import { listDelegationsForParent, getDelegation } from '../db/queries/delegations.js';
import { delegateToChildren, MAX_REWORK_REVISIONS, type DelegateChildDeps, type RecoveryDecision } from './delegate-child.js';
import { realDelegateDeps } from './node-actor-manager.js';
import { delegationEventsFor } from './delegation-events.js';
import type { ChildRunResult } from './delegation-review.js';

// The delegation loop wired the way production wires it — the durable ledger,
// real isolated git workspaces, the real merge gate, the real event log — with
// only a child's *execution* simulated. A child here "works" by writing files
// into its own workspace and reporting what a runtime would have observed.

process.env.ORG_FORKS_ROOT = mkdtempSync(join(homedir(), '.org-forks-lifecycle-test-'));
afterAll(() => rmSync(process.env.ORG_FORKS_ROOT!, { recursive: true, force: true }));

const TEST_DB = './test-delegation-lifecycle.db';
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

function repo(): string {
  const path = mkdtempSync(join(tmpdir(), 'lifecycle-base-'));
  made.push(path);
  writeFileSync(join(path, 'shared.ts'), 'export const shared = 0;\n');
  git(path, 'init', '-q'); git(path, 'config', 'user.email', 't@e.com'); git(path, 'config', 'user.name', 't');
  git(path, 'add', '-A'); git(path, 'commit', '-qm', 'first');
  return path;
}

const TESTS_PASS = { id: 'observed:npm test', command: 'npm test', passed: true };

interface Job { childId: string; goal: string; dispatch: number; workspace: string }

/** A parent with a repository, and deps whose child execution is `work`. */
type Work = Partial<ChildRunResult> & { writes?: Record<string, string | undefined> };
function harness(work: (job: Job) => Work, extra: Partial<DelegateChildDeps> = {}) {
  const db = createDb(TEST_DB);
  const base = repo();
  insertNode(db, {
    id: 'parent', parentId: null, goal: 'parent goal', state: 'DELEGATE', repoPath: base,
    contract: {
      goal: 'parent goal', definition_of_done: ['done'],
      authority: { tools: [] as string[], spawn_children: true, max_child_count: 6, budget_usd: 6 }, constraints: [],
    },
    createdAt: 't0', updatedAt: 't0',
  });
  const real = realDelegateDeps(db, 'parent');
  const dispatches = new Map<string, number>();
  const jobs: Job[] = [];
  const pending = new Map<string, Job>();
  const deps: DelegateChildDeps = {
    ...real,
    startChild: (childId, goal) => {
      const dispatch = (dispatches.get(childId) ?? 0) + 1;
      dispatches.set(childId, dispatch);
      const workspace = real.describeChild!(childId)!.workspace!.path;
      const job = { childId, goal, dispatch, workspace };
      jobs.push(job);
      pending.set(childId, job);
    },
    waitForChild: async (childId) => {
      const job = pending.get(childId)!;
      const { writes, ...result } = work(job);
      for (const [file, content] of Object.entries(writes ?? {})) if (content !== undefined) writeFileSync(join(job.workspace, file), content);
      return { succeeded: true, changedFiles: Object.keys(writes ?? {}), answer: 'done', ...result };
    },
    ...extra,
  };
  return { db, base, deps, jobs };
}

// `delegation.scheduled` is the work graph's own event, not an assignment's.
const lifecycle = (db: Db, childId?: string) => delegationEventsFor(db, 'parent')
  .filter((e) => e.type !== 'delegation.scheduled')
  .filter((e) => childId === undefined || (e.payload as { childId: string }).childId === childId)
  .map((e) => (e.payload as { to: string }).to);

describe('success: assign → work → report → accept → merge', () => {
  it('merges accepted work into the parent tree, and the event stream tells the whole story', async () => {
    const { db, base, deps } = harness((job) => ({
      writes: { [`${job.goal.includes('alpha') ? 'alpha' : 'beta'}.ts`]: 'export const x = 1;\n' },
      observedChecks: [TESTS_PASS],
    }));
    const result = await delegateToChildren({
      parentId: 'parent', goal: 'g', subgoals: ['build alpha', 'build beta'], acceptanceChecks: ['npm test passes'],
    }, deps);

    expect(result.succeeded).toBe(true);
    expect(existsSync(join(base, 'alpha.ts'))).toBe(true);
    expect(existsSync(join(base, 'beta.ts'))).toBe(true);
    const records = listDelegationsForParent(db, 'parent');
    expect(records.map((r) => r.status)).toEqual(['MERGED', 'MERGED']);
    for (const record of records) {
      expect(lifecycle(db, record.childId)).toEqual([
        'ASSIGNED', 'WORKING', 'REPORT_READY', 'UNDER_REVIEW', 'ACCEPTED', 'MERGING', 'MERGED',
      ]);
      expect(existsSync(record.workspace!.path)).toBe(false); // released once merged
    }
  });

  it('keeps the parent tree clean until the parent has accepted', async () => {
    let baseWhenReported: string | undefined;
    let baseRepo = '';
    const { base, deps } = harness(() => {
      baseWhenReported = git(baseRepo, 'status', '--porcelain');
      return { writes: { 'alpha.ts': 'x\n' }, observedChecks: [TESTS_PASS] };
    });
    baseRepo = base;
    await delegateToChildren({ parentId: 'parent', goal: 'g', subgoals: ['build alpha', 'build beta'] }, deps);
    // While children were still working and reporting, nothing had reached the tree.
    expect(baseWhenReported).toBe('');
  });
});

describe('parent rejection: the same child, the same worktree, a new revision', () => {
  it('sends the failed piece back to the same child in the same workspace, then accepts and merges', async () => {
    let baseAtFirstReport: boolean | undefined;
    let baseRepo = '';
    const { db, base, deps, jobs } = harness((job) => {
      if (job.dispatch === 1) {
        // The child produced work, but no evidence that the parent's check holds.
        baseAtFirstReport = existsSync(join(baseRepo, 'feature.ts'));
        return { writes: { 'feature.ts': 'export const v = 1;\n' }, observedChecks: [] };
      }
      return { writes: { 'feature.ts': 'export const v = 2;\n' }, observedChecks: [TESTS_PASS] };
    });
    baseRepo = base;

    const result = await delegateToChildren({
      parentId: 'parent', goal: 'g', subgoals: ['build the feature'], acceptanceChecks: ['npm test passes'],
    }, deps);

    expect(result.succeeded).toBe(true);
    // One child ever, dispatched twice, in one workspace.
    expect(jobs.map((j) => j.childId)).toEqual([jobs[0].childId, jobs[0].childId]);
    expect(new Set(jobs.map((j) => j.workspace)).size).toBe(1);
    expect(listNodes(db).filter((n) => n.parentId === 'parent')).toHaveLength(1);
    expect(listNodes(db).some((n) => n.supersededBy)).toBe(false);
    // Nothing merged on the first, unaccepted report.
    expect(baseAtFirstReport).toBe(false);
    expect(readFileSync(join(base, 'feature.ts'), 'utf8')).toBe('export const v = 2;\n');

    // The inspected event stream: the rework lifecycle, one child throughout.
    expect(lifecycle(db)).toEqual([
      'ASSIGNED', 'WORKING', 'REPORT_READY', 'UNDER_REVIEW', 'FEEDBACK_REQUIRED', 'REWORKING',
      'REPORT_READY', 'UNDER_REVIEW', 'ACCEPTED', 'MERGING', 'MERGED',
    ]);
    const record = listDelegationsForParent(db, 'parent')[0];
    expect(record.attempt).toBe(2);
    expect(record.feedbackHistory.length + (record.feedback ? 1 : 0)).toBeGreaterThan(0);
    // The rework told the child what failed, and did not resend the parent's brief.
    expect(jobs[1].goal).toContain('npm test passes');
    expect(jobs[1].goal.length).toBeLessThan(6_000);
  });

  it('rework cannot widen the child\'s budget or authority', async () => {
    const { db, deps } = harness((job) => (job.dispatch === 1
      ? { writes: { 'f.ts': '1\n' }, observedChecks: [] }
      : { writes: { 'f.ts': '2\n' }, observedChecks: [TESTS_PASS] }));
    let grantedBefore: unknown;
    const start = deps.startChild;
    deps.startChild = (childId, goal) => {
      grantedBefore ??= JSON.stringify([getNode(db, childId)?.contract.authority, getDelegation(db, listDelegationsForParent(db, 'parent')[0].id)?.budgetUsd]);
      start(childId, goal);
    };
    await delegateToChildren({ parentId: 'parent', goal: 'g', subgoals: ['build'], acceptanceChecks: ['npm test'] }, deps);
    const record = listDelegationsForParent(db, 'parent')[0];
    const after = JSON.stringify([getNode(db, record.childId)?.contract.authority, record.budgetUsd]);
    expect(after).toBe(grantedBefore);
    expect(record.authority).toEqual(getNode(db, record.childId)?.contract.authority);
    expect(record.budgetUsd).toBe(record.authority!.budget_usd);
  });

  it('evidence survives across revisions: the report and feedback stay on the assignment', async () => {
    const { db, deps } = harness(() => ({ writes: { 'f.ts': 'x\n' }, observedChecks: [], answer: 'I implemented it but did not run anything.' }));
    await delegateToChildren({ parentId: 'parent', goal: 'g', subgoals: ['build'], acceptanceChecks: ['npm test'] }, deps);
    const record = listDelegationsForParent(db, 'parent')[0];
    expect(record.status).toBe('ESCALATED');
    expect(record.report?.summary).toContain('did not run anything');
    expect(record.feedback?.failedChecks[0].check).toBe('npm test');
    expect(record.feedbackHistory.length).toBe(MAX_REWORK_REVISIONS);
    // The failed candidate is retained for the decision that follows.
    expect(existsSync(record.workspace!.path)).toBe(true);
  });
});

describe('a failed sibling does not affect an accepted one', () => {
  it('A is merged and retained; only B goes back for rework, and B never reaches the tree', async () => {
    const { db, base, deps, jobs } = harness((job) => (job.goal.includes('alpha')
      ? { writes: { 'alpha.ts': 'a\n' }, observedChecks: [TESTS_PASS] }
      : { writes: { 'beta.ts': 'b\n' }, observedChecks: [] }));
    const result = await delegateToChildren({
      parentId: 'parent', goal: 'g', subgoals: ['build alpha', 'build beta'], acceptanceChecks: ['npm test passes'],
    }, deps);

    expect(result.succeeded).toBe(false);
    const [a, b] = listDelegationsForParent(db, 'parent');
    expect(a.status).toBe('MERGED');
    expect(b.status).toBe('ESCALATED');
    expect(existsSync(join(base, 'alpha.ts'))).toBe(true);
    expect(existsSync(join(base, 'beta.ts'))).toBe(false);
    expect(jobs.filter((j) => j.childId === a.childId)).toHaveLength(1);
    expect(jobs.filter((j) => j.childId === b.childId)).toHaveLength(1 + MAX_REWORK_REVISIONS);
    expect(existsSync(b.workspace!.path)).toBe(true); // B's candidate retained
  });
});

describe('cancellation', () => {
  it('a cancelled child is not replaced, reworked or merged, and its workspace is released', async () => {
    const { db, base, deps } = harness(() => ({ succeeded: false, cancelled: true }));
    const result = await delegateToChildren({ parentId: 'parent', goal: 'g', subgoals: ['build alpha', 'build beta'] }, deps);
    expect(result.succeeded).toBe(false);
    const records = listDelegationsForParent(db, 'parent');
    expect(records.map((r) => r.status)).toEqual(['CANCELLED', 'CANCELLED']);
    expect(listNodes(db).filter((n) => n.parentId === 'parent')).toHaveLength(2); // no replacements
    for (const record of records) expect(existsSync(record.workspace!.path)).toBe(false);
    expect(git(base, 'status', '--porcelain')).toBe('');
  });

  it('a stopped parent creates no further children', async () => {
    let stopped = false;
    const { db, deps } = harness(() => { stopped = true; return { writes: { 'a.ts': '1\n' }, observedChecks: [TESTS_PASS] }; }, {
      parentStopped: () => stopped,
    });
    await delegateToChildren({
      parentId: 'parent', goal: 'g', subgoals: ['build alpha', 'then beta'], after: [[], [0]],
    }, deps);
    expect(listNodes(db).filter((n) => n.parentId === 'parent')).toHaveLength(1);
    expect(listDelegationsForParent(db, 'parent')).toHaveLength(1);
  });
});

describe('exceptional reassignment', () => {
  it('replaces the owner only through an explicit decision, and preserves the lineage', async () => {
    const decision: RecoveryDecision = {
      action: 'reassign', reason: 'this child\'s sandbox cannot run the toolchain', decidedBy: 'human:approval-3', evidenceRefs: ['run:42'],
    };
    // The first owner never produces evidence; whoever takes over does.
    let firstOwner: string | undefined;
    const { db, base, deps } = harness((job) => {
      firstOwner ??= job.childId;
      return job.childId === firstOwner
        ? { writes: { 'f.ts': 'broken\n' }, observedChecks: [] }
        : { writes: { 'f.ts': 'fixed\n' }, observedChecks: [TESTS_PASS] };
    }, { decideRecovery: async () => decision });

    const result = await delegateToChildren({
      parentId: 'parent', goal: 'g', subgoals: ['build'], acceptanceChecks: ['npm test passes'],
    }, deps);

    expect(result.succeeded).toBe(true);
    const [old, successor] = listDelegationsForParent(db, 'parent');
    expect(old.status).toBe('REASSIGNED');
    expect(old.reassignment).toMatchObject({ toChildId: successor.childId, toAssignmentId: successor.id, reason: decision.reason, decidedBy: 'human:approval-3' });
    expect(successor).toMatchObject({ reassignedFrom: old.id, status: 'MERGED' });
    expect(getNode(db, old.childId)?.supersededBy).toBe(successor.childId);
    expect(old.childId).not.toBe(successor.childId);
    // Never above what the old owner had: the replacement is capped, not re-granted.
    expect(successor.budgetUsd).toBeLessThanOrEqual(old.budgetUsd);
    expect(readFileSync(join(base, 'f.ts'), 'utf8')).toBe('fixed\n');
    // The stream shows the decision, not a silent fresh child.
    const events = delegationEventsFor(db, 'parent');
    expect(events.find((e) => e.type === 'delegation.reassigned')?.payload).toMatchObject({
      assignmentId: old.id, childId: old.childId, reassignedTo: successor.childId, reason: decision.reason, decidedBy: 'human:approval-3',
    });
    expect(existsSync(old.workspace!.path)).toBe(false); // the handed-on owner's workspace is cleaned up
  });

  it('never happens on its own, however many times the work fails', async () => {
    const { db, deps } = harness(() => ({ writes: { 'f.ts': 'x\n' }, observedChecks: [] }));
    await delegateToChildren({ parentId: 'parent', goal: 'g', subgoals: ['build'], acceptanceChecks: ['npm test'] }, deps);
    expect(listNodes(db).filter((n) => n.parentId === 'parent')).toHaveLength(1);
    expect(delegationEventsFor(db, 'parent').some((e) => e.type === 'delegation.reassigned')).toBe(false);
  });
});

describe('integration conflict', () => {
  it('two accepted siblings that overlap: the first merges, the second is INTEGRATION_BLOCKED — not a failure', async () => {
    // Both goals are free of file names, so nothing tells the scheduler they
    // touch the same file: they run together, and both write shared.ts.
    const { db, base, deps, jobs } = harness((job) => ({
      writes: { 'shared.ts': `export const shared = "${job.goal.includes('one') ? 'one' : 'two'}";\n` },
      observedChecks: [TESTS_PASS],
    }));
    const result = await delegateToChildren({
      parentId: 'parent', goal: 'g', subgoals: ['do part one', 'do part two'], acceptanceChecks: ['npm test passes'],
    }, deps);

    const [first, second] = listDelegationsForParent(db, 'parent');
    expect([first.status, second.status].sort()).toEqual(['INTEGRATION_BLOCKED', 'MERGED']);
    const blocked = first.status === 'INTEGRATION_BLOCKED' ? first : second;
    const merged = blocked === first ? second : first;
    expect(result.succeeded).toBe(false);
    expect(result.message).toMatch(/accepted but could not be merged/);
    expect(result.message).not.toMatch(/did not succeed/);
    // The merged one's work is in the tree, untouched by the conflict; the tree is clean of markers.
    const shared = readFileSync(join(base, 'shared.ts'), 'utf8');
    expect(shared).not.toContain('<<<<<<<');
    expect(git(base, 'ls-files', '-u')).toBe('');
    expect(shared).toContain(merged.goal.includes('one') ? '"one"' : '"two"');
    // No rework was spent on work that was right; its candidate is kept.
    expect(jobs.filter((j) => j.childId === blocked.childId)).toHaveLength(1);
    expect(existsSync(blocked.workspace!.path)).toBe(true);
    expect(lifecycle(db, blocked.childId).at(-1)).toBe('INTEGRATION_BLOCKED');
  });
});
