import { describe, it, expect, vi } from 'vitest';
import {
  delegateToChildren, createMemoryLedger, MAX_REWORK_REVISIONS,
  type DelegateChildDeps, type RecoveryDecision,
} from './delegate-child.js';
import type { ChildRunResult } from './delegation-review.js';

const PASS_TEST = { id: 'observed:npm test', command: 'npm test', passed: true };
const green = (over: Partial<ChildRunResult> = {}): ChildRunResult => ({
  succeeded: true, changedFiles: ['src/x.ts'], observedChecks: [PASS_TEST], answer: 'done', ...over,
});
const noEvidence = (over: Partial<ChildRunResult> = {}): ChildRunResult => ({
  succeeded: true, changedFiles: ['src/x.ts'], observedChecks: [], answer: 'done', ...over,
});

/** A parent, its children, and a scripted outcome per (child, dispatch). */
function world(
  script: (goal: string, dispatch: number, childId: string) => ChildRunResult,
  extra: Partial<DelegateChildDeps> & { integrate?: (id: string) => boolean } = {},
) {
  const log: string[] = [];
  const starts: Array<{ childId: string; goal: string }> = [];
  const goalOf = new Map<string, string>();
  const dispatches = new Map<string, number>();
  const { integrate, ...rest } = extra;
  const ledger = createMemoryLedger({
    integrate: (record) => { log.push(`integrate:${record.childId}`); return integrate ? integrate(record.childId) : true; },
    onTransition: (record, from) => log.push(`${record.childId}:${from ?? 'NEW'}>${record.status}`),
  });
  let next = 0;
  const deps: DelegateChildDeps = {
    createChildNode: vi.fn((_p: string, goal: string) => { const id = `c${++next}`; goalOf.set(id, goal); return id; }),
    recordCommitment: vi.fn(),
    startChild: vi.fn((childId: string, goal: string) => {
      log.push(`start:${childId}`);
      starts.push({ childId, goal });
      dispatches.set(childId, (dispatches.get(childId) ?? 0) + 1);
    }),
    waitForChild: vi.fn(async (childId: string) => script(goalOf.get(childId) ?? '', dispatches.get(childId) ?? 1, childId)),
    ledger,
    ...rest,
  };
  return { deps, ledger, log, starts };
}

const statusesOf = (log: string[], childId: string) =>
  log.filter((line) => line.startsWith(`${childId}:`)).map((line) => line.split('>')[1]);

describe('assign → work → report → accept → merge', () => {
  it('walks the whole contract, and merges only after the parent accepted', async () => {
    const { deps, log } = world(() => green());
    const result = await delegateToChildren(
      { parentId: 'p', goal: 'g', subgoals: ['Build the cart'], acceptanceChecks: ['npm test passes'] }, deps);

    expect(result.succeeded).toBe(true);
    expect(statusesOf(log, 'c1')).toEqual([
      'ASSIGNED', 'WORKING', 'REPORT_READY', 'UNDER_REVIEW', 'ACCEPTED', 'MERGING', 'MERGED',
    ]);
    expect(log.indexOf('c1:UNDER_REVIEW>ACCEPTED')).toBeLessThan(log.indexOf('integrate:c1'));
    expect(log.filter((line) => line === 'integrate:c1')).toHaveLength(1);
  });

  it('records the contract before the child starts', async () => {
    const { deps, ledger, log } = world(() => green());
    await delegateToChildren({ parentId: 'p', goal: 'g', subgoals: ['Build the cart'] }, deps);
    expect(log.indexOf('c1:NEW>ASSIGNED')).toBeLessThan(log.indexOf('start:c1'));
    expect(ledger.list()[0]).toMatchObject({ parentId: 'p', childId: 'c1', goal: 'Build the cart' });
  });

  it('gives each child its own definition of done rather than [goal], and stores the parent checks', async () => {
    const { deps, ledger } = world(() => green());
    await delegateToChildren({
      parentId: 'p', goal: 'g', subgoals: ['Build the cart', 'Write the docs'],
      definitionOfDoneBySubgoal: [['cart renders', 'cart persists'], ['docs build']],
      acceptanceChecks: ['npm test passes'],
      acceptanceChecksBySubgoal: [['file:src/cart.ts'], []],
    }, deps);
    const [cart, docs] = ledger.list();
    expect(cart.definitionOfDone).toEqual(['cart renders', 'cart persists']);
    expect(docs.definitionOfDone).toEqual(['docs build']);
    expect(cart.acceptanceChecks).toEqual(['npm test passes', 'file:src/cart.ts']);
    expect(docs.acceptanceChecks).toEqual(['npm test passes']);
    expect(deps.recordCommitment).toHaveBeenCalledWith('c1', 'Build the cart', ['cart renders', 'cart persists']);
  });

  it('derives a minimal DoD from the subgoal only when no richer contract was given, and keeps an explicit empty check list empty', async () => {
    const { deps, ledger } = world(() => green());
    await delegateToChildren({ parentId: 'p', goal: 'g', subgoals: ['Build the cart'], acceptanceChecks: [] }, deps);
    expect(ledger.list()[0]).toMatchObject({ definitionOfDone: ['Build the cart'], acceptanceChecks: [] });
  });

  it('puts the compact acceptance contract in the child envelope, not a transcript', async () => {
    const recordEnvelope = vi.fn();
    const { deps } = world(() => green(), { recordEnvelope });
    await delegateToChildren({
      parentId: 'p', goal: 'a very long parent goal '.repeat(50), subgoals: ['Build the cart'],
      acceptanceChecks: ['npm test passes'], approvedBudgetUsd: 2,
    }, deps);
    const [childId, goal, budget, contract] = recordEnvelope.mock.calls[0];
    expect(childId).toBe('c1');
    expect(goal).toBe('Build the cart');
    expect(budget).toBe(2);
    expect(contract).toMatchObject({ definitionOfDone: ['Build the cart'], acceptanceChecks: ['npm test passes'] });
    expect(JSON.stringify(contract)).not.toContain('a very long parent goal');
  });
});

describe('parent rejection → feedback → the same child reworks', () => {
  it('sends a failed acceptance back to the same child, in the same workspace, then accepts and merges', async () => {
    const discardWorkspace = vi.fn();
    const reopenChild = vi.fn();
    const describeChild = vi.fn(() => ({ budgetUsd: 1, workspace: { path: '/forks/c1', basePath: '/repo', revision: 'abc' } }));
    const { deps, ledger, log, starts } = world(
      (_goal, dispatch) => (dispatch === 1 ? noEvidence() : green()),
      { discardWorkspace, reopenChild, describeChild },
    );
    const result = await delegateToChildren(
      { parentId: 'p', goal: 'g', subgoals: ['Build the cart'], acceptanceChecks: ['npm test passes'] }, deps);

    expect(result.succeeded).toBe(true);
    // One child, ever. Same node, same assignment.
    expect(deps.createChildNode).toHaveBeenCalledTimes(1);
    expect(starts.map((s) => s.childId)).toEqual(['c1', 'c1']);
    expect(ledger.list()).toHaveLength(1);
    expect(statusesOf(log, 'c1')).toEqual([
      'ASSIGNED', 'WORKING', 'REPORT_READY', 'UNDER_REVIEW', 'FEEDBACK_REQUIRED', 'REWORKING',
      'REPORT_READY', 'UNDER_REVIEW', 'ACCEPTED', 'MERGING', 'MERGED',
    ]);
    // Nothing merged until the second review passed.
    expect(log.filter((line) => line.startsWith('integrate:'))).toEqual(['integrate:c1']);
    expect(log.indexOf('integrate:c1')).toBeGreaterThan(log.indexOf('c1:UNDER_REVIEW>ACCEPTED'));
    // The workspace was never released between the failed review and the rework.
    expect(discardWorkspace).not.toHaveBeenCalled();
    expect(describeChild).toHaveBeenCalledTimes(1);
    expect(reopenChild).toHaveBeenCalledWith('c1');
    expect(ledger.list()[0]).toMatchObject({ childId: 'c1', attempt: 2 });
    expect(ledger.list()[0].revision).toBeGreaterThan(8);
  });

  it('hands the rework the parent\'s feedback and the previous report, not the parent\'s transcript', async () => {
    const { deps, starts } = world(
      (_goal, dispatch) => (dispatch === 1
        ? noEvidence({ answer: 'Implemented the cart.\n\n```json\n{"status":"partial","summary":"cart done, untested","changedFiles":["src/x.ts"]}\n```' })
        : green()),
    );
    await delegateToChildren({
      parentId: 'p', goal: 'THE PARENT\'S WHOLE BRIEF '.repeat(200), subgoals: ['Build the cart'],
      acceptanceChecks: ['npm test passes'],
    }, deps);
    const rework = starts[1].goal;
    expect(rework.startsWith('Build the cart')).toBe(true);
    expect(rework).toContain('npm test passes');
    expect(rework).toContain('no evidence');
    expect(rework).toContain('cart done, untested');
    expect(rework).toContain('src/x.ts');
    expect(rework).not.toContain('THE PARENT\'S WHOLE BRIEF');
    expect(rework.length).toBeLessThan(6_000);
  });

  it('keeps sending the same child back until the rework limit, then escalates instead of replacing it', async () => {
    const { deps, ledger, starts, log } = world(() => noEvidence());
    const result = await delegateToChildren(
      { parentId: 'p', goal: 'g', subgoals: ['Build the cart'], acceptanceChecks: ['npm test passes'] }, deps);

    expect(result.succeeded).toBe(false);
    expect(deps.createChildNode).toHaveBeenCalledTimes(1);
    expect(starts).toHaveLength(1 + MAX_REWORK_REVISIONS);
    expect(new Set(starts.map((s) => s.childId))).toEqual(new Set(['c1']));
    expect(ledger.list()[0].status).toBe('ESCALATED');
    expect(log.filter((line) => line.startsWith('integrate:'))).toEqual([]);
    expect(ledger.list()[0].feedbackHistory.length + 1).toBe(1 + MAX_REWORK_REVISIONS);
    expect(result.message).toContain('Build the cart');
  });

  it('retains the failed attempt\'s report and feedback on the assignment', async () => {
    const { deps, ledger } = world(() => noEvidence({ answer: 'I tried.' }));
    await delegateToChildren(
      { parentId: 'p', goal: 'g', subgoals: ['Build the cart'], acceptanceChecks: ['npm test passes'] }, deps);
    const record = ledger.list()[0];
    expect(record.report?.summary).toBe('I tried.');
    expect(record.feedback?.failedChecks[0]).toMatchObject({ check: 'npm test passes' });
    expect(record.feedbackHistory.length).toBeGreaterThan(0);
  });

  it('a child that failed its own validation is reworked, not replaced', async () => {
    const { deps, starts } = world((_goal, dispatch) => (dispatch === 1 ? { succeeded: false, answer: 'ran out of turns' } : green()));
    const result = await delegateToChildren({ parentId: 'p', goal: 'g', subgoals: ['Ship it'] }, deps);
    expect(result.succeeded).toBe(true);
    expect(deps.createChildNode).toHaveBeenCalledTimes(1);
    expect(starts.map((s) => s.childId)).toEqual(['c1', 'c1']);
    expect(starts[1].goal).toContain('ran out of turns');
  });

  it('does not create a replacement even when a rework attempt throws away nothing — never marks the old child superseded', async () => {
    const markSuperseded = vi.fn();
    const { deps } = world(() => noEvidence(), { markSuperseded });
    await delegateToChildren({ parentId: 'p', goal: 'g', subgoals: ['x'], acceptanceChecks: ['npm test'] }, deps);
    expect(markSuperseded).not.toHaveBeenCalled();
  });
});

describe('a failed sibling does not drag down an accepted one', () => {
  it('retains and merges A while only B goes back for rework', async () => {
    const { deps, ledger, log, starts } = world(
      (goal) => (goal.startsWith('Piece A') ? green() : noEvidence()));
    const result = await delegateToChildren({
      parentId: 'p', goal: 'g', subgoals: ['Piece A', 'Piece B'], acceptanceChecks: ['npm test passes'],
    }, deps);

    expect(result.succeeded).toBe(false);
    expect(result.message).toContain('1 of 2');
    expect(result.message).toContain('Piece B');
    expect(result.message).not.toContain('Piece A;');
    const [a, b] = ledger.list();
    expect(a.status).toBe('MERGED');
    expect(b.status).toBe('ESCALATED');
    // A ran once and merged once; only B was sent back.
    expect(starts.filter((s) => s.childId === a.childId)).toHaveLength(1);
    expect(starts.filter((s) => s.childId === b.childId)).toHaveLength(1 + MAX_REWORK_REVISIONS);
    expect(log.filter((line) => line.startsWith('integrate:'))).toEqual([`integrate:${a.childId}`]);
    expect(deps.createChildNode).toHaveBeenCalledTimes(2);
  });

  it('does not start a piece that depends on one that never got accepted, and does not call it failed', async () => {
    const { deps, ledger } = world(() => noEvidence());
    const result = await delegateToChildren({
      parentId: 'p', goal: 'g', subgoals: ['Research', 'Build from the research'], after: [[], [0]],
      acceptanceChecks: ['npm test passes'],
    }, deps);
    expect(result.succeeded).toBe(false);
    expect(deps.createChildNode).toHaveBeenCalledTimes(1);
    expect(ledger.list()).toHaveLength(1);
    expect(result.message).toContain('1 of 1');
    expect(result.message).toContain('not started');
  });

  it('waits to start a dependent until its prerequisite is merged, and hands it that report', async () => {
    const { deps, log, starts } = world(
      (goal) => green({ answer: goal.startsWith('Research') ? 'The API is at /v2.' : 'built' }),
      { getFindings: (childId: string) => (childId === 'c1' ? 'The API is at /v2.' : '') },
    );
    await delegateToChildren({
      parentId: 'p', goal: 'g', subgoals: ['Research', 'Build from the research'], after: [[], [0]],
    }, deps);
    expect(log.indexOf('integrate:c1')).toBeLessThan(log.indexOf('start:c2'));
    expect(starts[1].goal).toContain('The API is at /v2.');
  });
});

describe('stopping is not failing', () => {
  it('a cancelled child stays cancelled: no review, no rework, no replacement, workspace released', async () => {
    const discardWorkspace = vi.fn();
    const { deps, ledger, log, starts } = world(() => ({ succeeded: false, cancelled: true }), { discardWorkspace });
    const result = await delegateToChildren({ parentId: 'p', goal: 'g', subgoals: ['Build the cart', 'Then wire it'], after: [[], [0]] }, deps);

    expect(result.succeeded).toBe(false);
    expect(deps.createChildNode).toHaveBeenCalledTimes(1);
    expect(starts).toHaveLength(1);
    expect(ledger.list()[0].status).toBe('CANCELLED');
    expect(statusesOf(log, 'c1')).not.toContain('UNDER_REVIEW');
    expect(log.filter((line) => line.startsWith('integrate:'))).toEqual([]);
    expect(discardWorkspace).toHaveBeenCalledTimes(1);
  });

  it('once the parent is stopped, a finished child is not reviewed into rework and no new child appears', async () => {
    let stopped = false;
    const { deps, ledger, starts } = world(() => noEvidence(), { parentStopped: () => stopped });
    (deps.startChild as ReturnType<typeof vi.fn>).mockImplementation(() => { stopped = true; });
    const result = await delegateToChildren({
      parentId: 'p', goal: 'g', subgoals: ['a'], acceptanceChecks: ['npm test'],
    }, deps);
    expect(result.succeeded).toBe(false);
    expect(deps.createChildNode).toHaveBeenCalledTimes(1);
    expect(starts).toHaveLength(0);
    expect(ledger.list()[0].status).toBe('CANCELLED');
  });

  it('creates no assignment at all for pieces after the parent stopped', async () => {
    let stopped = false;
    const { deps, ledger } = world(() => green(), { parentStopped: () => stopped });
    deps.waitForChild = vi.fn(async () => { stopped = true; return green(); });
    await delegateToChildren({ parentId: 'p', goal: 'g', subgoals: ['a', 'b'], after: [[], [0]] }, deps);
    expect(deps.createChildNode).toHaveBeenCalledTimes(1);
    expect(ledger.list()).toHaveLength(1);
  });
});

describe('reassignment is an explicit decision, never a retry', () => {
  const reassign: RecoveryDecision = {
    action: 'reassign', reason: 'the runtime keeps crashing on this machine', decidedBy: 'human:approval-7', evidenceRefs: ['run:9'],
  };

  it('replaces the owner only when the decision says so, and records who, why and what it replaces', async () => {
    const markSuperseded = vi.fn();
    const decideRecovery = vi.fn(async () => reassign);
    const { deps, ledger, log } = world(
      (_goal, _dispatch, childId) => (childId === 'c1' ? noEvidence() : green()),
      { decideRecovery, markSuperseded, remainingBudget: () => 0.8 },
    );
    const result = await delegateToChildren(
      { parentId: 'p', goal: 'g', subgoals: ['Build the cart'], acceptanceChecks: ['npm test passes'], approvedBudgetUsd: 1 }, deps);

    expect(result.succeeded).toBe(true);
    expect(decideRecovery).toHaveBeenCalledTimes(1);
    const [oldAssignment, newAssignment] = ledger.list();
    expect(oldAssignment).toMatchObject({ childId: 'c1', status: 'REASSIGNED' });
    expect(oldAssignment.reassignment).toMatchObject({
      toChildId: 'c2', toAssignmentId: newAssignment.id, reason: reassign.reason, decidedBy: 'human:approval-7',
    });
    expect(newAssignment).toMatchObject({ childId: 'c2', reassignedFrom: oldAssignment.id, status: 'MERGED' });
    expect(markSuperseded).toHaveBeenCalledWith('c1', 'c2');
    expect(log.filter((line) => line.startsWith('integrate:'))).toEqual(['integrate:c2']);
    // The old owner's lineage is intact and points forward.
    expect(statusesOf(log, 'c1')).toEqual(['ASSIGNED', 'WORKING', 'REPORT_READY', 'UNDER_REVIEW', 'FEEDBACK_REQUIRED', 'REASSIGNED']);
  });

  it('caps the replacement at what the old owner had left — reassignment cannot widen the budget', async () => {
    const { deps } = world(
      (_goal, _dispatch, childId) => (childId === 'c1' ? noEvidence() : green()),
      { decideRecovery: async () => reassign, remainingBudget: () => 0.8 },
    );
    await delegateToChildren({ parentId: 'p', goal: 'g', subgoals: ['x'], acceptanceChecks: ['npm test'], approvedBudgetUsd: 1 }, deps);
    const create = (deps.createChildNode as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(create[4]).toBe(0.8);
  });

  it('refuses to reassign when nothing is left to spend, and escalates instead', async () => {
    const { deps, ledger } = world(() => noEvidence(), { decideRecovery: async () => reassign, remainingBudget: () => 0 });
    const result = await delegateToChildren({ parentId: 'p', goal: 'g', subgoals: ['x'], acceptanceChecks: ['npm test'] }, deps);
    expect(result.succeeded).toBe(false);
    expect(deps.createChildNode).toHaveBeenCalledTimes(1);
    expect(ledger.list()).toHaveLength(1);
    expect(ledger.list()[0].status).toBe('ESCALATED');
  });

  it('will not reassign on a decision with no reason or no decider', async () => {
    for (const bad of [{ action: 'reassign', reason: '', decidedBy: 'x' }, { action: 'reassign', reason: 'because', decidedBy: '' }]) {
      const { deps, ledger } = world(() => noEvidence(), { decideRecovery: async () => bad as RecoveryDecision });
      await delegateToChildren({ parentId: 'p', goal: 'g', subgoals: ['x'], acceptanceChecks: ['npm test'] }, deps);
      expect(deps.createChildNode).toHaveBeenCalledTimes(1);
      expect(ledger.list()[0].status).toBe('ESCALATED');
    }
  });

  it('never reassigns on its own: an ordinary validation failure stays with the same child', async () => {
    const { deps } = world(() => noEvidence());
    await delegateToChildren({ parentId: 'p', goal: 'g', subgoals: ['x'], acceptanceChecks: ['npm test'] }, deps);
    expect(deps.createChildNode).toHaveBeenCalledTimes(1);
  });
});

describe('the economic governor cannot override a hard acceptance failure', () => {
  it('can stop the rework early by escalating', async () => {
    const { deps, starts, ledger } = world(() => noEvidence(), {
      decideRecovery: async () => ({ action: 'escalate', reason: 'another revision costs more than the piece is worth' }),
    });
    await delegateToChildren({ parentId: 'p', goal: 'g', subgoals: ['x'], acceptanceChecks: ['npm test'] }, deps);
    expect(starts).toHaveLength(1);
    expect(ledger.list()[0].status).toBe('ESCALATED');
  });

  it('cannot extend the rework limit', async () => {
    const { deps, starts } = world(() => noEvidence(), { decideRecovery: async () => ({ action: 'rework' }) });
    await delegateToChildren({ parentId: 'p', goal: 'g', subgoals: ['x'], acceptanceChecks: ['npm test'] }, deps);
    expect(starts).toHaveLength(1 + MAX_REWORK_REVISIONS);
  });

  it('has no way to accept: an unknown action is an escalation, and nothing merges', async () => {
    const { deps, log, ledger } = world(() => noEvidence(), { decideRecovery: async () => ({ action: 'merge' }) as never });
    await delegateToChildren({ parentId: 'p', goal: 'g', subgoals: ['x'], acceptanceChecks: ['npm test'] }, deps);
    expect(ledger.list()[0].status).toBe('ESCALATED');
    expect(log.filter((line) => line.startsWith('integrate:'))).toEqual([]);
  });
});

describe('integration conflict is not an implementation failure', () => {
  it('an accepted child whose merge conflicts is INTEGRATION_BLOCKED: no rework, workspace kept, not called failed', async () => {
    const discardWorkspace = vi.fn();
    const { deps, ledger, starts, log } = world(() => green(), { integrate: () => false, discardWorkspace });
    const result = await delegateToChildren(
      { parentId: 'p', goal: 'g', subgoals: ['Build the cart'], acceptanceChecks: ['npm test passes'] }, deps);

    expect(result.succeeded).toBe(false);
    expect(ledger.list()[0].status).toBe('INTEGRATION_BLOCKED');
    expect(statusesOf(log, 'c1')).toEqual([
      'ASSIGNED', 'WORKING', 'REPORT_READY', 'UNDER_REVIEW', 'ACCEPTED', 'MERGING', 'INTEGRATION_BLOCKED']);
    // The work was right; nobody redoes it.
    expect(starts).toHaveLength(1);
    expect(deps.createChildNode).toHaveBeenCalledTimes(1);
    expect(discardWorkspace).not.toHaveBeenCalled();
    expect(result.message).toMatch(/accepted but could not be merged/);
    expect(result.message).not.toMatch(/did not pass|did not succeed/);
  });

  it('serializes merges, so two accepted siblings never integrate at the same moment', async () => {
    let inFlight = 0;
    let overlapped = false;
    const { deps } = world(() => green(), {});
    deps.ledger = createMemoryLedger({
      integrate: async () => {
        inFlight++;
        if (inFlight > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return true;
      },
    });
    await delegateToChildren({ parentId: 'p', goal: 'g', subgoals: ['a', 'b', 'c'] }, deps);
    expect(overlapped).toBe(false);
  });
});
