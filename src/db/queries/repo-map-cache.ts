import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { memory } from '../schema.js';

const KIND = 'repo_map';

/** The repository map built for this committed HEAD, if one was stored. Keyed
 *  by HEAD alone, so every node on the same commit shares one build. Any miss
 *  or malformed row returns null — the caller then dispatches the bare goal. */
export function getRepoMap(db: Db, head: string): string | null {
  const row = db.select().from(memory)
    .where(and(eq(memory.kind, KIND), eq(memory.key, head)))
    .all()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  const map = (row?.value as { map?: unknown } | undefined)?.map;
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
