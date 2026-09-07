import { createHash } from 'node:crypto';
import { eq, desc, lt, inArray } from 'drizzle-orm';
import type { Db } from '../client.js';
import { events } from '../schema.js';

export interface EventRecord {
  nodeId: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

/** One row's own fingerprint, over the row before it and this row's content.
 *
 *  Chained this way, editing any past row changes every hash after it, so the
 *  log is tamper-EVIDENT. It is not tamper-proof and must never be described as
 *  such: anyone who can write the file can also rebuild the whole chain. What it
 *  defends against is a single quiet edit, which is the realistic case. */
export function hashEvent(prevHash: string | null, record: EventRecord): string {
  return createHash('sha256')
    .update(prevHash ?? '')
    .update('\u0000')
    .update(record.nodeId)
    .update('\u0000')
    .update(record.type)
    .update('\u0000')
    .update(JSON.stringify(record.payload ?? null))
    .update('\u0000')
    .update(record.createdAt)
    .digest('hex');
}

function headHash(db: Db): string | null {
  const last = db.select({ hash: events.hash }).from(events).orderBy(desc(events.id)).limit(1).get();
  return last?.hash ?? null;
}

/** Returns the new row's id, which is what lets a live subscriber tell an event
 *  it already replayed from history apart from a genuinely new one. */
export function appendEvent(db: Db, record: EventRecord): number {
  const prevHash = headHash(db);
  const hash = hashEvent(prevHash, record);
  return Number(db.insert(events).values({ ...record, prevHash, hash }).run().lastInsertRowid);
}

export interface ChainVerdict {
  ok: boolean;
  checked: number;
  /** The first row whose content no longer matches its recorded hash. */
  brokenAtId?: number;
  /** Rows written before chaining existed. Not a break — they simply predate it. */
  unchained: number;
}

/** Walks the log and reports the first row that does not match its hash.
 *  Rows with no hash are counted, not failed: a database that predates chaining
 *  is old, not tampered with. */
export function verifyChain(db: Db): ChainVerdict {
  const rows = db.select().from(events).orderBy(events.id).all();
  let prevHash: string | null = null;
  let checked = 0;
  let unchained = 0;

  for (const row of rows) {
    if (!row.hash) { unchained++; continue; }
    const expected = hashEvent(prevHash, {
      nodeId: row.nodeId, type: row.type, payload: row.payload, createdAt: row.createdAt,
    });
    if (expected !== row.hash || (row.prevHash ?? null) !== prevHash) {
      return { ok: false, checked, brokenAtId: row.id, unchained };
    }
    prevHash = row.hash;
    checked++;
  }
  return { ok: true, checked, unchained };
}

export function listEventsForNode(db: Db, nodeId: string) {
  return db.select().from(events).where(eq(events.nodeId, nodeId)).all();
}

/** Every event under a set of nodes, oldest first. What a whole case's proof
 *  ledger reads from. */
export function listEventsForNodes(db: Db, nodeIds: string[]) {
  if (nodeIds.length === 0) return [];
  return db.select().from(events).where(inArray(events.nodeId, nodeIds)).orderBy(events.id).all();
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
