import { asc, eq, notInArray } from 'drizzle-orm';
import type { Db } from '../client.js';
import { delegations } from '../schema.js';
import {
  DelegationPatchSchema, DelegationRecordSchema, NewDelegationSchema,
  canTransitionDelegation, DelegationNotFoundError, DelegationStaleError, IllegalDelegationTransitionError,
  type DelegationPatch, type DelegationRecord, type NewDelegation,
} from '../../schemas/delegation.js';

export { DelegationNotFoundError, DelegationStaleError, IllegalDelegationTransitionError };

// The columns are the authority for status/revision/attempt (they are what is
// compare-and-swapped); the blob carries everything else.
function toRecord(row: typeof delegations.$inferSelect): DelegationRecord {
  return DelegationRecordSchema.parse({
    ...row.data,
    id: row.id, parentId: row.parentId, childId: row.childId,
    status: row.status, revision: row.revision, attempt: row.attempt,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  });
}

/** Opens an assignment: always `ASSIGNED`, revision 1, attempt 1. A caller does
 *  not get to open one already accepted. */
export function createDelegation(db: Db, input: NewDelegation, now: string): DelegationRecord {
  const contract = NewDelegationSchema.parse(input);
  const record = DelegationRecordSchema.parse({
    ...contract, status: 'ASSIGNED', revision: 1, attempt: 1, feedbackHistory: [],
    createdAt: now, updatedAt: now,
  });
  db.insert(delegations).values({
    id: record.id, parentId: record.parentId, childId: record.childId, data: record,
    status: record.status, revision: record.revision, attempt: record.attempt,
    createdAt: now, updatedAt: now,
  }).run();
  return record;
}

export function getDelegation(db: Db, id: string): DelegationRecord | undefined {
  const row = db.select().from(delegations).where(eq(delegations.id, id)).get();
  return row && toRecord(row);
}

export function listDelegationsForParent(db: Db, parentId: string): DelegationRecord[] {
  return db.select().from(delegations).where(eq(delegations.parentId, parentId))
    .orderBy(asc(delegations.createdAt), asc(delegations.id)).all().map(toRecord);
}

export function listDelegationsForChild(db: Db, childId: string): DelegationRecord[] {
  return db.select().from(delegations).where(eq(delegations.childId, childId))
    .orderBy(asc(delegations.createdAt), asc(delegations.id)).all().map(toRecord);
}

export interface UpdateDelegationOptions {
  /** Refuse unless the row is still at this revision. */
  expectedRevision?: number;
}

/** Applies a patch and bumps the revision, atomically.
 *
 *  Validated in three layers before a byte is written: the patch itself (strict,
 *  so a field that would widen the contract is rejected rather than ignored),
 *  the move against the transition table, and the revision the caller believes
 *  it is writing over. */
export function updateDelegation(
  db: Db,
  id: string,
  patch: DelegationPatch,
  now: string,
  options: UpdateDelegationOptions = {},
): DelegationRecord {
  const parsed = DelegationPatchSchema.parse(patch);
  return db.transaction((tx) => {
    const row = tx.select().from(delegations).where(eq(delegations.id, id)).get();
    if (!row) throw new DelegationNotFoundError(id);
    const current = toRecord(row);
    if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision) {
      throw new DelegationStaleError(id, options.expectedRevision, current.revision);
    }
    // Staying put is a snapshot update (a report, a workspace), not a move.
    const to = parsed.status ?? current.status;
    if (to !== current.status && !canTransitionDelegation(current.status, to)) {
      throw new IllegalDelegationTransitionError(id, current.status, to);
    }
    const next = DelegationRecordSchema.parse({
      ...current, ...parsed, status: to,
      revision: current.revision + 1, updatedAt: now,
    });
    tx.update(delegations).set({
      data: next, status: next.status, revision: next.revision, attempt: next.attempt, updatedAt: now,
    }).where(eq(delegations.id, id)).run();
    return next;
  });
}

/** Host paths of the isolated workspaces that still hold work nobody has taken
 *  responsibility for: everything except merged, cancelled or handed-on
 *  assignments. What an orphan sweep must not delete — an escalated or
 *  conflicted assignment's candidate *is* the evidence its decision is about. */
export function listRetainedWorkspacePaths(db: Db): string[] {
  return db.select().from(delegations)
    .where(notInArray(delegations.status, ['MERGED', 'CANCELLED', 'REASSIGNED'])).all()
    .flatMap((row) => (row.data.workspace?.path ? [row.data.workspace.path] : []));
}
