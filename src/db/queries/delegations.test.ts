import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import {
  createDelegation, getDelegation, updateDelegation,
  listDelegationsForParent, listDelegationsForChild,
  DelegationNotFoundError, DelegationStaleError, IllegalDelegationTransitionError,
} from './delegations.js';
import { canTransitionDelegation, isTerminalDelegationStatus, DELEGATION_STATUSES } from '../../schemas/delegation.js';

const TEST_DB = './test-delegations.db';

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const base = {
  id: 'a1', parentId: 'p1', childId: 'c1', goal: 'Add the cart',
  definitionOfDone: ['cart renders'], acceptanceChecks: ['npm test'], dependencies: ['a0'],
  budgetUsd: 1.5,
};

describe('delegation records', () => {
  it('opens one assignment as ASSIGNED, revision 1, attempt 1, with its whole contract', () => {
    const db = createDb(TEST_DB);
    const created = createDelegation(db, base, '2026-09-30T00:00:00.000Z');
    expect(created).toMatchObject({
      id: 'a1', parentId: 'p1', childId: 'c1', goal: 'Add the cart',
      definitionOfDone: ['cart renders'], acceptanceChecks: ['npm test'], dependencies: ['a0'],
      status: 'ASSIGNED', revision: 1, attempt: 1, budgetUsd: 1.5,
      createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z',
    });
  });

  it('returns the latest row by assignment id', () => {
    const db = createDb(TEST_DB);
    createDelegation(db, base, 't0');
    updateDelegation(db, 'a1', { status: 'WORKING' }, 't1');
    expect(getDelegation(db, 'a1')).toMatchObject({ status: 'WORKING', revision: 2, updatedAt: 't1' });
    expect(getDelegation(db, 'missing')).toBeUndefined();
  });

  it('bumps the revision on every write, in one transaction', () => {
    const db = createDb(TEST_DB);
    createDelegation(db, base, 't0');
    const working = updateDelegation(db, 'a1', { status: 'WORKING' }, 't1');
    const ready = updateDelegation(db, 'a1', { status: 'REPORT_READY' }, 't2');
    expect([working.revision, ready.revision]).toEqual([2, 3]);
  });

  it('preserves the report and feedback snapshots across later writes', () => {
    const db = createDb(TEST_DB);
    createDelegation(db, base, 't0');
    updateDelegation(db, 'a1', { status: 'WORKING' }, 't1');
    const report = { assignmentId: 'a1', status: 'ready' as const, summary: 'done', changedFiles: ['cart.ts'] };
    updateDelegation(db, 'a1', { status: 'REPORT_READY', report }, 't2');
    updateDelegation(db, 'a1', { status: 'UNDER_REVIEW' }, 't3');
    const feedback = {
      assignmentId: 'a1', revision: 4,
      failedChecks: [{ check: 'npm test', observed: 'no run', expected: 'green run', evidenceRefs: [] }],
      requiredChanges: ['run the tests'],
    };
    updateDelegation(db, 'a1', { status: 'FEEDBACK_REQUIRED', feedback }, 't4');
    const row = getDelegation(db, 'a1')!;
    expect(row.report?.summary).toBe('done');
    expect(row.report?.changedFiles).toEqual(['cart.ts']);
    expect(row.feedback?.failedChecks[0].check).toBe('npm test');
  });

  it('rejects an invalid status through Zod before anything is persisted', () => {
    const db = createDb(TEST_DB);
    createDelegation(db, base, 't0');
    expect(() => updateDelegation(db, 'a1', { status: 'DONE' as never }, 't1')).toThrow();
    expect(getDelegation(db, 'a1')).toMatchObject({ status: 'ASSIGNED', revision: 1 });
  });

  it('fails deterministically for a missing id and for a stale writer', () => {
    const db = createDb(TEST_DB);
    createDelegation(db, base, 't0');
    expect(() => updateDelegation(db, 'nope', { status: 'WORKING' }, 't1')).toThrow(DelegationNotFoundError);
    updateDelegation(db, 'a1', { status: 'WORKING' }, 't1');
    expect(() => updateDelegation(db, 'a1', { status: 'REPORT_READY' }, 't2', { expectedRevision: 1 }))
      .toThrow(DelegationStaleError);
    expect(getDelegation(db, 'a1')?.status).toBe('WORKING');
  });

  it('lists a parent\'s assignments and a child\'s', () => {
    const db = createDb(TEST_DB);
    createDelegation(db, base, 't0');
    createDelegation(db, { ...base, id: 'a2', childId: 'c2' }, 't1');
    createDelegation(db, { ...base, id: 'a3', parentId: 'other', childId: 'c3' }, 't2');
    expect(listDelegationsForParent(db, 'p1').map((d) => d.id)).toEqual(['a1', 'a2']);
    expect(listDelegationsForChild(db, 'c3').map((d) => d.id)).toEqual(['a3']);
  });

  it('refuses a second assignment with the same id', () => {
    const db = createDb(TEST_DB);
    createDelegation(db, base, 't0');
    expect(() => createDelegation(db, base, 't1')).toThrow();
  });
});

describe('delegation transitions are the invariant', () => {
  it('will not merge what the parent has not accepted', () => {
    const db = createDb(TEST_DB);
    createDelegation(db, base, 't0');
    updateDelegation(db, 'a1', { status: 'WORKING' }, 't1');
    updateDelegation(db, 'a1', { status: 'REPORT_READY' }, 't2');
    // A finished child is REPORT_READY. It is not one step from MERGING.
    expect(() => updateDelegation(db, 'a1', { status: 'MERGING' }, 't3')).toThrow(IllegalDelegationTransitionError);
    expect(() => updateDelegation(db, 'a1', { status: 'MERGED' }, 't3')).toThrow(IllegalDelegationTransitionError);
    expect(() => updateDelegation(db, 'a1', { status: 'ACCEPTED' }, 't3')).toThrow(IllegalDelegationTransitionError);
    expect(getDelegation(db, 'a1')?.status).toBe('REPORT_READY');
  });

  it('only allows MERGING from ACCEPTED (or a retry from INTEGRATION_BLOCKED)', () => {
    const into = DELEGATION_STATUSES.filter((from) => canTransitionDelegation(from, 'MERGING'));
    expect(into.sort()).toEqual(['ACCEPTED', 'INTEGRATION_BLOCKED']);
  });

  it('never sends a failed review to a different child on its own', () => {
    // FEEDBACK_REQUIRED → REWORKING keeps the child. REASSIGNED is reachable
    // (an explicit decision writes it) but UNDER_REVIEW cannot jump there.
    expect(canTransitionDelegation('UNDER_REVIEW', 'REASSIGNED')).toBe(false);
    expect(canTransitionDelegation('UNDER_REVIEW', 'FEEDBACK_REQUIRED')).toBe(true);
    expect(canTransitionDelegation('FEEDBACK_REQUIRED', 'REWORKING')).toBe(true);
    expect(canTransitionDelegation('REWORKING', 'REPORT_READY')).toBe(true);
  });

  it('treats merged, reassigned and cancelled as final', () => {
    expect(DELEGATION_STATUSES.filter(isTerminalDelegationStatus).sort()).toEqual(['CANCELLED', 'MERGED', 'REASSIGNED']);
    const db = createDb(TEST_DB);
    createDelegation(db, base, 't0');
    updateDelegation(db, 'a1', { status: 'CANCELLED' }, 't1');
    expect(() => updateDelegation(db, 'a1', { status: 'WORKING' }, 't2')).toThrow(IllegalDelegationTransitionError);
  });

  it('cannot widen the contract through a patch', () => {
    const db = createDb(TEST_DB);
    createDelegation(db, base, 't0');
    expect(() => updateDelegation(db, 'a1', { budgetUsd: 999 } as never, 't1')).toThrow();
    expect(() => updateDelegation(db, 'a1', { acceptanceChecks: [] } as never, 't1')).toThrow();
    expect(() => updateDelegation(db, 'a1', { childId: 'c9' } as never, 't1')).toThrow();
    expect(getDelegation(db, 'a1')).toMatchObject({ budgetUsd: 1.5, acceptanceChecks: ['npm test'], childId: 'c1' });
  });
});
