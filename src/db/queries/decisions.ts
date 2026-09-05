import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { decisions } from '../schema.js';
import type { Decision } from '../../schemas/decision.js';

export function insertDecision(db: Db, decision: Decision): void {
  db.insert(decisions).values({
    id: decision.id, nodeId: decision.nodeId, data: decision, createdAt: decision.createdAt,
  }).run();
}

export function listDecisionsForNode(db: Db, nodeId: string): Decision[] {
  return db.select().from(decisions).where(eq(decisions.nodeId, nodeId)).all().map((r) => r.data);
}
