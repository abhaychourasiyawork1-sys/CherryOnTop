import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { memory } from '../schema.js';
import type { RepoEntry } from '../../intelligence/repo-map.js';

const KIND = 'repo_map';
const INVENTORY_KIND = 'repo_inventory';

function latest(db: Db, kind: string, key: string) {
  return db.select().from(memory)
    .where(and(eq(memory.kind, kind), eq(memory.key, key)))
    .all()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}

/** The repository map built for this committed HEAD, if one was stored. Keyed
 *  by HEAD alone, so every node on the same commit shares one build. Any miss
 *  or malformed row returns null — the caller then dispatches the bare goal. */
export function getRepoMap(db: Db, head: string): string | null {
  const map = (latest(db, KIND, head)?.value as { map?: unknown } | undefined)?.map;
  return typeof map === 'string' && map.length > 0 ? map : null;
}

export function putRepoMap(db: Db, head: string, map: string, createdAt: string): void {
  db.insert(memory).values({
    id: randomUUID(),
    kind: KIND,
    key: head,
    value: { map },
    confidence: null,
    nodeId: null,
    createdAt,
  }).run();
}

/** The unbudgeted file+symbol scan for this committed HEAD.
 *
 *  Cached separately from the rendered map above, and this is the row that
 *  matters now: the scan is the expensive half (a `git ls-files` plus a read of
 *  every source file), and unlike a rendered map it does not go stale when the
 *  token budget changes — selection applies the budget fresh on every dispatch.
 *  So N siblings on one commit share one scan and still get N different,
 *  goal-shaped contexts. */
export function getRepoInventory(db: Db, head: string): RepoEntry[] | null {
  const entries = (latest(db, INVENTORY_KIND, head)?.value as { entries?: unknown } | undefined)?.entries;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  // A malformed row is a miss, not a crash: the caller rebuilds.
  return entries.every((e) => typeof (e as RepoEntry)?.path === 'string' && Array.isArray((e as RepoEntry)?.symbols))
    ? (entries as RepoEntry[])
    : null;
}

export function putRepoInventory(db: Db, head: string, entries: RepoEntry[], createdAt: string): void {
  db.insert(memory).values({
    id: randomUUID(),
    kind: INVENTORY_KIND,
    key: head,
    value: { entries },
    confidence: null,
    nodeId: null,
    createdAt,
  }).run();
}
