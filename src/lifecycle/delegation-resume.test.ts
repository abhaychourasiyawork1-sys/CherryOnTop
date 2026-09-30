import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { existsSync, unlinkSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createDb, type Db } from '../db/client.js';
import { insertNode, listNodes } from '../db/queries/nodes.js';
import { listDelegationsForParent, listDelegationsForChild } from '../db/queries/delegations.js';
import { saveDelegationPlan } from '../db/queries/delegation-plans.js';
import type { ParsedPlan } from '../intelligence/plan.js';
import { appendEvent } from '../db/queries/events.js';
import { integrateFork, type WorkspaceFork } from '../execution/workspace-fork.js';
import { delegateToChildren, type DelegateChildDeps, type DelegationLedger } from './delegate-child.js';
import { realDelegateDeps, observeCandidate, delegateNode, childCompletion } from './node-actor-manager.js';

// The daemon restarts in the middle of a delegation. What survives is the
// database and the git workspaces; what does not is the loop that was driving
// the assignments. A parent that is then resumed must carry on from what the
// records say — not refuse to split a second time and do the work itself, which
// is what it used to do.

process.env.ORG_FORKS_ROOT = mkdtempSync(join(homedir(), '.org-forks-resume-test-'));
afterAll(() => rmSync(process.env.ORG_FORKS_ROOT!, { recursive: true, force: true }));

const TEST_DB = './test-delegation-resume.db';
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
const TESTS_PASS = { id: 'observed:npm test', command: 'npm test', passed: true };

function setup() {
  const db = createDb(TEST_DB);
  const base = mkdtempSync(join(tmpdir(), 'resume-base-'));
  made.push(base);
  writeFileSync(join(base, 'README.md'), 'hello\n');
  git(base, 'init', '-q'); git(base, 'config', 'user.email', 't@e.com'); git(base, 'config', 'user.name', 't');
  git(base, 'add', '-A'); git(base, 'commit', '-qm', 'first');
  insertNode(db, {
    id: 'parent', parentId: null, goal: 'parent goal', state: 'DELEGATE', repoPath: base,
    contract: {
      goal: 'parent goal', definition_of_done: ['done'],
      authority: { tools: [] as string[], spawn_children: true, max_child_count: 6, budget_usd: 6 }, constraints: [],
    },
    createdAt: 't0', updatedAt: 't0',
  });
  return { db, base };
}

const workspaceOf = (db: Db, childId: string) =>
  listDelegationsForChild(db, childId).map((r) => r.workspace).filter(Boolean).at(-1);

type Work = (goal: string, workspace: string, dispatch: number) => Record<string, string>;

/** Deps whose children "work" by `work`, and which record every dispatch. */
function simulated(db: Db, work: Work, checks = [TESTS_PASS]) {
  const real = realDelegateDeps(db, 'parent');
  const started: Array<{ childId: string; goal: string }> = [];
  const dispatches = new Map<string, number>();
  const goals = new Map<string, string>();
  const deps: DelegateChildDeps = {
    ...real,
    createChildNode: (...args) => { const id = real.createChildNode(...args); goals.set(id, args[1]); return id; },
    startChild: (childId, goal) => {
      started.push({ childId, goal });
      dispatches.set(childId, (dispatches.get(childId) ?? 0) + 1);
    },
    waitForChild: async (childId) => {
      const workspace = workspaceOf(db, childId) ?? real.describeChild!(childId)?.workspace;
      const writes = work(goals.get(childId) ?? '', workspace!.path, dispatches.get(childId) ?? 0);
      for (const [file, content] of Object.entries(writes)) writeFileSync(join(workspace!.path, file), content);
      return observeCandidate({ succeeded: true, answer: 'done', observedChecks: checks }, workspace);
    },
  };
  return { deps, started };
}

/** A ledger that lets a write through and then "crashes": the state is
 *  committed, the process is gone. Merges go through `merge`, not `transition`,
 *  so a crash at MERGING or MERGED has to be injected there. */
function crashingAfter(real: DelegationLedger, status: string): DelegationLedger {
  const crash = () => new Error(`daemon died after ${status}`);
  return {
    ...real,
    transition: (id, to, patch, detail, options) => {
      const result = real.transition(id, to, patch, detail, options);
      if (to === status) throw crash();
      return result;
    },
    merge: async (id) => {
      if (status === 'MERGING') {
        real.transition(id, 'MERGING'); // written; the apply never happened
        throw crash();
      }
      const merged = await real.merge(id);
      if (status === 'MERGED') throw crash();
      return merged;
    },
  };
}

const PLAN: ParsedPlan = { subgoals: ['build alpha'], after: [[]], definitionOfDone: [[]], acceptanceChecks: [['npm test passes']] };

async function firstRunCrashingAt(status: string, plan = PLAN, work: Work = () => ({ 'alpha.ts': 'export {};\n' })) {
  const { db, base } = setup();
  saveDelegationPlan(db, 'parent', plan, 't1');
  const sim = simulated(db, work);
  const crashing = { ...sim.deps, ledger: crashingAfter(sim.deps.ledger!, status) };
  await expect(delegateToChildren({
    parentId: 'parent', goal: 'g', subgoals: plan.subgoals, after: plan.after,
    acceptanceChecksBySubgoal: plan.acceptanceChecks,
  }, crashing)).rejects.toThrow(`daemon died after ${status}`);
  return { db, base };
}

const afterRestart = (db: Db, work: Work = () => ({}), checks = [TESTS_PASS]) => {
  const sim = simulated(db, work, checks);
  return { ...sim, resume: () => delegateNode(db, 'parent', { goal: 'parent goal' }, () => sim.deps) };
};

describe('a parent resumed after a restart picks its delegation back up', () => {
  it('reviews and merges a child that had already reported — it does not refuse to split, and does not redo the work', async () => {
    const { db, base } = await firstRunCrashingAt('REPORT_READY');
    const [before] = listDelegationsForParent(db, 'parent');
    expect(before.status).toBe('REPORT_READY');
    expect(existsSync(join(base, 'alpha.ts'))).toBe(false); // unmerged, as it must be

    const restarted = afterRestart(db);
    const result = await restarted.resume();

    expect(result.succeeded).toBe(true);
    expect(restarted.started).toHaveLength(0); // the child that finished is not started again
    expect(listNodes(db).filter((n) => n.parentId === 'parent')).toHaveLength(1); // nor is a second one made
    expect(readFileSync(join(base, 'alpha.ts'), 'utf8')).toBe('export {};\n');
    expect(listDelegationsForParent(db, 'parent')).toHaveLength(1);
    expect(listDelegationsForParent(db, 'parent')[0].status).toBe('MERGED');
    expect(existsSync(before.workspace!.path)).toBe(false); // released once merged
  });

  it('finishes a merge the crash cut off, applying the changes once', async () => {
    const { db, base } = await firstRunCrashingAt('MERGING');
    expect(listDelegationsForParent(db, 'parent')[0].status).toBe('MERGING');

    const result = await afterRestart(db).resume();

    expect(result.succeeded).toBe(true);
    expect(readFileSync(join(base, 'alpha.ts'), 'utf8')).toBe('export {};\n');
    expect(git(base, 'ls-files', '-u')).toBe('');
    expect(listDelegationsForParent(db, 'parent')[0].status).toBe('MERGED');
  });

  it('recognises a merge that had already landed before the crash, rather than applying it again', async () => {
    const { db, base } = await firstRunCrashingAt('MERGING');
    const [record] = listDelegationsForParent(db, 'parent');
    // The apply happened; the daemon died before it could write MERGED.
    const fork: WorkspaceFork = { ...record.workspace!, release: () => {} };
    expect(integrateFork(fork)).toBe(true);
    const staged = git(base, 'status', '--porcelain');

    const result = await afterRestart(db).resume();

    expect(result.succeeded).toBe(true);
    expect(listDelegationsForParent(db, 'parent')[0].status).toBe('MERGED');
    expect(readFileSync(join(base, 'alpha.ts'), 'utf8')).toBe('export {};\n');
    expect(git(base, 'status', '--porcelain')).toBe(staged); // untouched by the resume
  });

  it('sends the same child back for rework when the restart came after a refusal', async () => {
    const twoChecks = { ...PLAN, acceptanceChecks: [['npm test passes', 'tsc --noEmit is clean']] };
    const { db, base } = await firstRunCrashingAt('FEEDBACK_REQUIRED', twoChecks, () => ({ 'alpha.ts': 'x\n' }));
    const [before] = listDelegationsForParent(db, 'parent');
    expect(before.status).toBe('FEEDBACK_REQUIRED');

    // Rework is a dispatch: the person resuming the parent chose to spend it.
    const tsc = { id: 'observed:tsc', command: 'tsc --noEmit', passed: true };
    const restarted = afterRestart(db, () => ({ 'alpha.ts': 'fixed\n' }), [TESTS_PASS, tsc]);
    const result = await restarted.resume();

    expect(result.succeeded).toBe(true);
    expect(restarted.started.map((s) => s.childId)).toEqual([before.childId]); // the same child
    expect(restarted.started[0].goal).toContain('tsc --noEmit');
    expect(listNodes(db).filter((n) => n.parentId === 'parent')).toHaveLength(1);
    expect(readFileSync(join(base, 'alpha.ts'), 'utf8')).toBe('fixed\n');
  });

  it('starts the piece that was waiting behind the crash, once what it needed has merged', async () => {
    const plan: ParsedPlan = {
      subgoals: ['build alpha', 'build beta from alpha'], after: [[], [0]],
      definitionOfDone: [[], []], acceptanceChecks: [[], []],
    };
    // Group 1 merges; the daemon dies after that piece's MERGED, before the second is assigned.
    const { db, base } = await firstRunCrashingAt('MERGED', plan, () => ({ 'alpha.ts': 'a\n' }));
    expect(listDelegationsForParent(db, 'parent')).toHaveLength(1);
    expect(readFileSync(join(base, 'alpha.ts'), 'utf8')).toBe('a\n');

    const restarted = afterRestart(db, () => ({ 'beta.ts': 'b\n' }));
    const result = await restarted.resume();

    expect(result.succeeded).toBe(true);
    const records = listDelegationsForParent(db, 'parent');
    expect(records.map((r) => [r.piece, r.status])).toEqual([[0, 'MERGED'], [1, 'MERGED']]);
    expect(records[1].dependencies).toEqual([records[0].id]);
    expect(restarted.started).toHaveLength(1); // only the piece that had not been assigned
    expect(existsSync(join(base, 'beta.ts'))).toBe(true);
  });

  it('gives a piece assigned after the restart the contract the planner wrote for it', async () => {
    // What the planner said each piece must produce and how the parent will
    // check it travels with the saved plan, so a piece assigned later — even
    // after a restart — is held to it.
    const plan: ParsedPlan = {
      subgoals: ['build alpha', 'build beta from alpha'], after: [[], [0]],
      definitionOfDone: [[], ['beta renders', 'beta is exported']],
      acceptanceChecks: [[], ['npm test passes']],
    };
    const { db } = await firstRunCrashingAt('MERGED', plan, () => ({ 'alpha.ts': 'a\n' }));
    const restarted = afterRestart(db, () => ({ 'beta.ts': 'b\n' }));
    const result = await restarted.resume();

    expect(result.succeeded).toBe(true);
    const [, beta] = listDelegationsForParent(db, 'parent');
    expect(beta.definitionOfDone).toEqual(['beta renders', 'beta is exported']);
    expect(beta.acceptanceChecks).toEqual(['npm test passes']);
  });

  it('keeps the old rule when everything already settled: a node that delegated does not split again', async () => {
    // A single piece that merged before the crash: nothing left to resume.
    const { db } = await firstRunCrashingAt('MERGED');
    const result = await afterRestart(db).resume();
    expect(result.notDelegatable).toBe(true);
    expect(result.message).toContain('already split');
  });

  it('keeps the old rule when there is no saved plan to resume from', async () => {
    const { db, base } = setup();
    insertNode(db, {
      id: 'orphan', parentId: 'parent', goal: 'x', state: 'COMPLETE', repoPath: base,
      contract: {
        goal: 'x', definition_of_done: ['d'],
        authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 1 }, constraints: [],
      },
      createdAt: 't', updatedAt: 't',
    });
    const sim = simulated(db, () => ({}));
    const result = await delegateNode(db, 'parent', { goal: 'g' }, () => sim.deps);
    expect(result.notDelegatable).toBe(true);
    expect(sim.started).toHaveLength(0);
  });
});

describe('where a resumed parent finds its children', () => {
  const contract = {
    goal: 'c', definition_of_done: ['d'],
    authority: { tools: [] as string[], spawn_children: false, max_child_count: 0, budget_usd: 1 }, constraints: [] as string[],
  };
  const child = (db: Db, state: string) =>
    insertNode(db, { id: 'kid', parentId: null, goal: 'c', contract, state, createdAt: 't', updatedAt: 't' });

  it('reads a child that finished before the restart from its record, with no actor to wait on', async () => {
    const db = createDb(TEST_DB);
    child(db, 'COMPLETE');
    appendEvent(db, { nodeId: 'kid', type: 'validation.result', payload: { passed: true }, createdAt: 't1' });
    expect(await childCompletion(db, 'kid')).toEqual({ succeeded: true });
  });

  it('does not mistake an unvalidated completion for success', async () => {
    const db = createDb(TEST_DB);
    child(db, 'COMPLETE');
    expect(await childCompletion(db, 'kid')).toEqual({ succeeded: false });
  });

  it('reports a child stopped before the restart as stopped, not failed', async () => {
    const db = createDb(TEST_DB);
    child(db, 'CANCELLED');
    expect(await childCompletion(db, 'kid')).toEqual({ succeeded: false, cancelled: true });
  });

  it('reports a child that failed as failed', async () => {
    const db = createDb(TEST_DB);
    child(db, 'FAILED');
    expect(await childCompletion(db, 'kid')).toEqual({ succeeded: false });
  });

  it('reports a child that is neither running nor recoverable as not having succeeded', async () => {
    const db = createDb(TEST_DB);
    child(db, 'INTERRUPTED'); // no saved snapshot to restart from
    expect(await childCompletion(db, 'kid')).toEqual({ succeeded: false });
  });
});
