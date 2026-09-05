import { and, eq } from 'drizzle-orm';
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

export function resolveApproval(db: Db, id: string, status: 'approved' | 'rejected', resolvedAt: string): void {
  db.update(approvals).set({ status, resolvedAt }).where(eq(approvals.id, id)).run();
}
