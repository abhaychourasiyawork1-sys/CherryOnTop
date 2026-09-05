import { eq, desc, lt } from 'drizzle-orm';
import type { Db } from '../client.js';
import { events } from '../schema.js';

export interface EventRecord {
  nodeId: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

/** Returns the new row's id, which is what lets a live subscriber tell an event
 *  it already replayed from history apart from a genuinely new one. */
export function appendEvent(db: Db, record: EventRecord): number {
  return Number(db.insert(events).values(record).run().lastInsertRowid);
}

export function listEventsForNode(db: Db, nodeId: string) {
  return db.select().from(events).where(eq(events.nodeId, nodeId)).all();
}

/** The newest `limit` events across every node, returned oldest-first so a
 *  transcript can replay them in the order they happened. `before` pages
 *  backwards by row id — ids are monotonic, unlike the ISO timestamps, several
 *  of which routinely share a millisecond during a fast run. */
export function listRecentEvents(db: Db, opts: { limit: number; before?: number }) {
  const rows = db
    .select()
    .from(events)
    .where(opts.before === undefined ? undefined : lt(events.id, opts.before))
    .orderBy(desc(events.id))
    .limit(opts.limit)
    .all();
  return rows.reverse();
}
