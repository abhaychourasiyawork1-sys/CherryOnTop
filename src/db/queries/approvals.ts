import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../client.js';
import { approvals } from '../schema.js';

/** The approval row. Deliberately the only definition — nothing parses approvals
 *  from untrusted input, so a Zod schema alongside it would just be a second
 *  place to keep in sync. */
export interface ApprovalRecord {
  id: string; nodeId: string; reason: string; status: string; createdAt: string; resolvedAt?: string;
}

export function insertApproval(db: Db, record: ApprovalRecord): void {
  db.insert(approvals).values(record).run();
}

export function getApproval(db: Db, id: string): ApprovalRecord | undefined {
  return db.select().from(approvals).where(eq(approvals.id, id)).get() as ApprovalRecord | undefined;
}

export function getPendingApproval(db: Db, nodeId: string): ApprovalRecord | undefined {
  return db.select().from(approvals)
    .where(and(eq(approvals.nodeId, nodeId), eq(approvals.status, 'pending')))
    .get() as ApprovalRecord | undefined;
}

export function resolveApproval(db: Db, id: string, status: 'approved' | 'rejected' | 'cancelled', resolvedAt: string): void {
  db.update(approvals).set({ status, resolvedAt }).where(eq(approvals.id, id)).run();
}

export function listPendingApprovals(db: Db): ApprovalRecord[] {
  return db.select().from(approvals).where(eq(approvals.status, 'pending')).all() as ApprovalRecord[];
}

/** Every approval ever raised under a set of nodes, resolved ones included. The
 *  inbox wants what is pending; a receipt wants the whole history, because "a
 *  person rejected this" is as much a part of the record as "a person allowed
 *  it". */
export function approvalsForNodes(db: Db, nodeIds: string[]): ApprovalRecord[] {
  if (nodeIds.length === 0) return [];
  return db.select().from(approvals).where(inArray(approvals.nodeId, nodeIds)).all() as ApprovalRecord[];
}
