import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { runs } from '../db/schema.js';

export interface RunRecord {
  id: string;
  conversationId: string;
  caseId: string;
  goal: string;
  status: 'RUNNING' | 'WAITING' | 'COMPLETE' | 'FAILED' | 'CANCELLED';
  mandateSnapshot: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export function createRun(
  db: Db,
  input: {
    id: string;
    conversationId: string;
    caseId: string;
    goal: string;
    mandateSnapshot: Record<string, unknown>;
    now: string;
  },
): RunRecord {
  const record: RunRecord = { ...input, status: 'RUNNING' };
  db.insert(runs).values(record).run();
  return record;
}

export function getRun(db: Db, id: string): RunRecord | undefined {
  return db.select().from(runs).where(eq(runs.id, id)).get() as RunRecord | undefined;
}

export function listRuns(db: Db, conversationId: string): RunRecord[] {
  return db.select().from(runs).where(eq(runs.conversationId, conversationId))
    .orderBy(desc(runs.updatedAt)).all() as RunRecord[];
}
