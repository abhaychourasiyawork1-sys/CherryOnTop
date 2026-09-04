import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { events } from '../schema.js';

export interface EventRecord {
  nodeId: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

export function appendEvent(db: Db, record: EventRecord): void {
  db.insert(events).values(record).run();
}

export function listEventsForNode(db: Db, nodeId: string) {
  return db.select().from(events).where(eq(events.nodeId, nodeId)).all();
}
