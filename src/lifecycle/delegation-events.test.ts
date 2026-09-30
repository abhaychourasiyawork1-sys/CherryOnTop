import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../db/client.js';
import { listEventsForNode } from '../db/queries/events.js';
import { getDelegation } from '../db/queries/delegations.js';
import { openDelegation, transitionDelegation, delegationEventType, delegationEventsFor } from './delegation-events.js';
import { subscribeAll } from '../events/bus.js';

const TEST_DB = './test-delegation-events.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const contract = {
  id: 'a1', parentId: 'p1', childId: 'c1', goal: 'Add the cart',
  definitionOfDone: ['cart renders'], acceptanceChecks: ['npm test'], dependencies: [], budgetUsd: 1,
};

describe('delegation events', () => {
  it('writes one event per transition, on the parent, through the tamper-evident log', () => {
    const db = createDb(TEST_DB);
    openDelegation(db, contract, 't0');
    transitionDelegation(db, 'a1', 'WORKING', {}, 't1');
    transitionDelegation(db, 'a1', 'REPORT_READY', {
      report: { assignmentId: 'a1', status: 'ready', summary: 'done' },
    }, 't2', { evidenceRefs: ['artifact:1'] });
    transitionDelegation(db, 'a1', 'UNDER_REVIEW', {}, 't3');
    transitionDelegation(db, 'a1', 'FEEDBACK_REQUIRED', {
      feedback: { assignmentId: 'a1', revision: 4, failedChecks: [{ check: 'npm test', observed: 'no run', expected: 'green', evidenceRefs: [] }] },
    }, 't4', { reason: 'acceptance failed: npm test' });
    transitionDelegation(db, 'a1', 'REWORKING', { attempt: 2 }, 't5');
    transitionDelegation(db, 'a1', 'REPORT_READY', {}, 't6');
    transitionDelegation(db, 'a1', 'UNDER_REVIEW', {}, 't7');
    transitionDelegation(db, 'a1', 'ACCEPTED', {}, 't8', { evidenceRefs: ['observed:npm test'] });
    transitionDelegation(db, 'a1', 'MERGING', {}, 't9');
    transitionDelegation(db, 'a1', 'MERGED', {}, 't10');

    const events = listEventsForNode(db, 'p1').filter((e) => e.type.startsWith('delegation.'));
    expect(events.map((e) => e.type)).toEqual([
      'delegation.assigned', 'delegation.working', 'delegation.report_ready', 'delegation.under_review',
      'delegation.feedback_required', 'delegation.reworking', 'delegation.report_ready', 'delegation.under_review',
      'delegation.accepted', 'delegation.merging', 'delegation.merged',
    ]);
    // Same child throughout: the second lifecycle never shows a fresh one.
    expect(new Set(events.map((e) => (e.payload as { childId: string }).childId))).toEqual(new Set(['c1']));
    expect(events.every((e) => e.hash && e.nodeId === 'p1')).toBe(true);
  });

  it('carries the assignment, parent, child, revision and the reason needed to rebuild the transition', () => {
    const db = createDb(TEST_DB);
    openDelegation(db, contract, 't0');
    transitionDelegation(db, 'a1', 'WORKING', {}, 't1');
    transitionDelegation(db, 'a1', 'REPORT_READY', {}, 't2');
    transitionDelegation(db, 'a1', 'UNDER_REVIEW', {}, 't3');
    transitionDelegation(db, 'a1', 'FEEDBACK_REQUIRED', {
      feedback: { assignmentId: 'a1', revision: 5, failedChecks: [{ check: 'npm test', observed: 'red', expected: 'green', evidenceRefs: ['observed:npm test'] }] },
    }, 't4', { reason: 'acceptance failed', evidenceRefs: ['observed:npm test'] });

    const last = delegationEventsFor(db, 'p1').at(-1)!;
    expect(last).toMatchObject({
      type: 'delegation.feedback_required',
      payload: {
        assignmentId: 'a1', parentId: 'p1', childId: 'c1', revision: 5, attempt: 1,
        from: 'UNDER_REVIEW', to: 'FEEDBACK_REQUIRED',
        reason: 'acceptance failed', evidenceRefs: ['observed:npm test'],
        failedChecks: ['npm test'],
      },
    });
    expect(getDelegation(db, 'a1')?.revision).toBe(5);
  });

  it('records the assignment itself as the first event, with its contract summarised', () => {
    const db = createDb(TEST_DB);
    openDelegation(db, contract, 't0');
    expect(delegationEventsFor(db, 'p1')[0]).toMatchObject({
      type: 'delegation.assigned',
      payload: { assignmentId: 'a1', childId: 'c1', revision: 1, to: 'ASSIGNED', acceptanceChecks: ['npm test'], budgetUsd: 1 },
    });
  });

  it('records a reassignment with the old child, the new child and why', () => {
    const db = createDb(TEST_DB);
    openDelegation(db, contract, 't0');
    transitionDelegation(db, 'a1', 'WORKING', {}, 't1');
    transitionDelegation(db, 'a1', 'REASSIGNED', {
      reassignment: { toAssignmentId: 'a2', toChildId: 'c2', reason: 'runtime keeps crashing', evidenceRefs: ['run:9'], decidedBy: 'human:approval-7', at: 't2' },
    }, 't2', { reason: 'runtime keeps crashing', evidenceRefs: ['run:9'] });
    expect(delegationEventsFor(db, 'p1').at(-1)).toMatchObject({
      type: 'delegation.reassigned',
      payload: { childId: 'c1', reassignedTo: 'c2', toAssignmentId: 'a2', reason: 'runtime keeps crashing', decidedBy: 'human:approval-7' },
    });
  });

  it('writes nothing when the transition is refused, so the log never claims a move that did not happen', () => {
    const db = createDb(TEST_DB);
    openDelegation(db, contract, 't0');
    expect(() => transitionDelegation(db, 'a1', 'MERGING', {}, 't1')).toThrow();
    expect(delegationEventsFor(db, 'p1').map((e) => e.type)).toEqual(['delegation.assigned']);
  });

  it('publishes to the live bus as well as the durable log', () => {
    const db = createDb(TEST_DB);
    const seen: string[] = [];
    const off = subscribeAll((event) => { if (event.type.startsWith('delegation.')) seen.push(event.type); });
    openDelegation(db, contract, 't0');
    transitionDelegation(db, 'a1', 'WORKING', {}, 't1');
    off();
    expect(seen).toEqual(['delegation.assigned', 'delegation.working']);
  });

  it('names an event after its status', () => {
    expect(delegationEventType('INTEGRATION_BLOCKED')).toBe('delegation.integration_blocked');
  });
});
