/** The audit trail of a work contract, and the one place a status may change.
 *
 *  Every status change goes through `transitionDelegation`, which writes the row
 *  and then the event — so the operation that successfully moves the assignment
 *  is the operation that records it. Nothing else emits these events, which is
 *  what keeps the log from disagreeing with the row (a projection that also
 *  wrote events would double them; business logic that wrote them separately
 *  could record a move that a refused transition never made).
 *
 *  Events go through the existing tamper-evident `appendEvent`, on the
 *  *parent's* node: assigning, reviewing, accepting and reassigning are the
 *  parent's acts, and a subtree query already gathers the children's own. */
import { appendEvent, listEventsForNode } from '../db/queries/events.js';
import {
  createDelegation, getDelegation, updateDelegation, type UpdateDelegationOptions,
} from '../db/queries/delegations.js';
import { publish } from '../events/bus.js';
import type { Db } from '../db/client.js';
import type {
  DelegationPatch, DelegationRecord, DelegationStatus, NewDelegation,
} from '../schemas/delegation.js';

export const DELEGATION_EVENT_PREFIX = 'delegation.';

export function delegationEventType(status: DelegationStatus): string {
  return `${DELEGATION_EVENT_PREFIX}${status.toLowerCase()}`;
}

export interface DelegationEventDetail {
  /** Why — required in spirit for feedback, escalation, blocking and reassignment. */
  reason?: string;
  /** References to what the transition rests on. Refs, not content. */
  evidenceRefs?: string[];
}

function record(db: Db, event: { nodeId: string; type: string; payload: Record<string, unknown>; createdAt: string }): void {
  const id = appendEvent(db, event);
  publish({ id, ...event });
}

function payloadFor(
  before: DelegationStatus | null,
  after: DelegationRecord,
  patch: DelegationPatch,
  detail: DelegationEventDetail,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    assignmentId: after.id, parentId: after.parentId, childId: after.childId,
    revision: after.revision, attempt: after.attempt,
    from: before, to: after.status,
  };
  if (detail.reason) payload.reason = detail.reason;
  if (detail.evidenceRefs?.length) payload.evidenceRefs = detail.evidenceRefs;
  if (after.status === 'FEEDBACK_REQUIRED' && patch.feedback) {
    payload.failedChecks = patch.feedback.failedChecks?.map((failed) => failed.check) ?? [];
  }
  if (after.status === 'REASSIGNED' && patch.reassignment) {
    payload.reassignedTo = patch.reassignment.toChildId;
    payload.toAssignmentId = patch.reassignment.toAssignmentId;
    payload.decidedBy = patch.reassignment.decidedBy;
  }
  return payload;
}

/** Opens an assignment and records that it was made. */
export function openDelegation(db: Db, input: NewDelegation, now: string): DelegationRecord {
  const created = createDelegation(db, input, now);
  const payload = payloadFor(null, created, {}, {});
  payload.acceptanceChecks = created.acceptanceChecks;
  payload.definitionOfDone = created.definitionOfDone;
  payload.budgetUsd = created.budgetUsd;
  if (created.reassignedFrom) payload.reassignedFrom = created.reassignedFrom;
  record(db, { nodeId: created.parentId, type: delegationEventType('ASSIGNED'), payload, createdAt: now });
  return created;
}

/** Moves an assignment and records the move. A refused transition throws before
 *  either is written. */
export function transitionDelegation(
  db: Db,
  id: string,
  to: DelegationStatus,
  patch: DelegationPatch,
  now: string,
  detail: DelegationEventDetail = {},
  options: UpdateDelegationOptions = {},
): DelegationRecord {
  const before = getDelegation(db, id)?.status ?? null;
  const after = updateDelegation(db, id, { ...patch, status: to }, now, options);
  record(db, {
    nodeId: after.parentId, type: delegationEventType(to),
    payload: payloadFor(before, after, patch, detail), createdAt: now,
  });
  return after;
}

/** A parent's delegation events, oldest first. */
export function delegationEventsFor(db: Db, parentId: string) {
  return listEventsForNode(db, parentId).filter((event) => event.type.startsWith(DELEGATION_EVENT_PREFIX));
}
