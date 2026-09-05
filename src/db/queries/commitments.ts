import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { commitments } from '../schema.js';
import type { Commitment } from '../../schemas/commitment.js';

export function insertCommitment(db: Db, commitment: Commitment, now: string): void {
  db.insert(commitments).values({
    id: commitment.id, owner: commitment.owner, data: commitment,
    status: commitment.status, createdAt: now, updatedAt: now,
  }).run();
}

export function updateCommitmentStatus(db: Db, id: string, status: Commitment['status'], updatedAt: string): void {
  db.update(commitments).set({ status, updatedAt }).where(eq(commitments.id, id)).run();
}

// status is denormalized into its own column so it can be queried without
// decoding JSON; the column is the authority, so reads overlay it onto the blob
// rather than letting updateCommitmentStatus have to rewrite the blob too.
export function getCommitment(db: Db, id: string): Commitment | undefined {
  const row = db.select().from(commitments).where(eq(commitments.id, id)).get();
  return row && { ...row.data, status: row.status as Commitment['status'] };
}

export function listCommitmentsForNode(db: Db, owner: string): Commitment[] {
  return db.select().from(commitments).where(eq(commitments.owner, owner)).all()
    .map((r) => ({ ...r.data, status: r.status as Commitment['status'] }));
}
