import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { dodItems } from '../schema.js';

export type DodState = 'met' | 'unmet' | 'unverified';

export interface DodItemRecord {
  id: string;
  nodeId: string;
  text: string;
  state: DodState;
  artifactId: string | null;
  eventId: number | null;
  note: string | null;
  checkedAt: string | null;
  createdAt: string;
}

export function insertDodItems(
  db: Db,
  nodeId: string,
  texts: string[],
  now: string,
  idFor: (index: number) => string,
): void {
  texts.forEach((text, index) => {
    db.insert(dodItems).values({
      id: idFor(index), nodeId, text, state: 'unverified',
      artifactId: null, eventId: null, note: null, checkedAt: null, createdAt: now,
    }).run();
  });
}

export function listDodForNode(db: Db, nodeId: string): DodItemRecord[] {
  return db.select().from(dodItems).where(eq(dodItems.nodeId, nodeId)).all() as DodItemRecord[];
}

export function setDodState(
  db: Db,
  id: string,
  state: DodState,
  evidence: { artifactId?: string | null; eventId?: number | null; note?: string | null },
  checkedAt: string,
): void {
  db.update(dodItems).set({
    state,
    artifactId: evidence.artifactId ?? null,
    eventId: evidence.eventId ?? null,
    note: evidence.note ?? null,
    checkedAt,
  }).where(eq(dodItems.id, id)).run();
}

/** How far along one node's definition of done is. `unverified` is counted
 *  separately from `unmet` on purpose: "we did not check" and "we checked and it
 *  is not done" are different answers, and collapsing them is how a checklist
 *  starts lying. */
export function dodProgress(items: DodItemRecord[]): { met: number; unmet: number; unverified: number; total: number } {
  return {
    met: items.filter((item) => item.state === 'met').length,
    unmet: items.filter((item) => item.state === 'unmet').length,
    unverified: items.filter((item) => item.state === 'unverified').length,
    total: items.length,
  };
}
