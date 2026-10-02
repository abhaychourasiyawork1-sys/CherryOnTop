/** What information control remembers between dispatches.
 *
 *  Everything lives in the existing `memory` table: one row per observation,
 *  never an aggregate, so a belief is always re-derivable from its evidence.
 *  It holds no transcript fragments, only counts, signatures and short findings.
 *
 *   - `ic_refetch`  (key: cell)       elisions made and refetches seen, per (tool kind, representation)
 *   - `ic_refetch_obs` (key: source)  one elision's features and whether it was refetched: the refetch
 *                                     model's training rows (`live` from real refetches, `proxy` seeded offline)
 *   - `ic_turns`    (key: role)       how many turns a dispatch took (the survival estimate's data)
 *   - `ic_finish`   (key: 'finish')   unverified finishes and whether validation then failed
 *   - `ic_negative` (key: task root)  searches that found nothing, with provenance
 *   - `ic_repeat`   (key: 'repeat')   an identical repeat of a failed call into an unchanged world that
 *                                     was allowed to run: did it come out differently, did the agent repeat it again
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { memory } from '../db/schema.js';
import type { RefetchBelief, RepeatBelief } from './economics.js';
import type { RefetchFeatures } from './refetch-model.js';

export const KIND = {
  refetch: 'ic_refetch',
  refetchObs: 'ic_refetch_obs',
  turns: 'ic_turns',
  finish: 'ic_finish',
  negative: 'ic_negative',
  repeat: 'ic_repeat',
} as const;

function insert(db: Db, kind: string, key: string, value: unknown, nodeId: string | null): void {
  db.insert(memory).values({
    id: randomUUID(), kind, key, value, confidence: null, nodeId, createdAt: new Date().toISOString(),
  }).run();
}

function rows<T>(db: Db, kind: string, key?: string): T[] {
  const where = key === undefined ? eq(memory.kind, kind) : and(eq(memory.kind, kind), eq(memory.key, key));
  return db.select().from(memory).where(where).all().map((r) => r.value as T);
}

export function refetchBeliefs(db: Db): Map<string, RefetchBelief> {
  const out = new Map<string, RefetchBelief>();
  for (const r of db.select().from(memory).where(eq(memory.kind, KIND.refetch)).all()) {
    const v = r.value as RefetchBelief;
    const b = out.get(r.key) ?? { refetched: 0, elided: 0 };
    out.set(r.key, { refetched: b.refetched + (v.refetched ?? 0), elided: b.elided + (v.elided ?? 0) });
  }
  return out;
}

export function recordRefetch(db: Db, cell: string, belief: RefetchBelief, nodeId: string): void {
  insert(db, KIND.refetch, cell, belief, nodeId);
}

export interface RefetchObservation {
  features: RefetchFeatures;
  used: boolean;
}

/** The most recent `limit` training rows, live and seeded alike. */
export function refetchObservations(db: Db, limit = 5000): RefetchObservation[] {
  return db.select().from(memory).where(eq(memory.kind, KIND.refetchObs)).orderBy(desc(memory.createdAt)).limit(limit).all()
    .map((r) => r.value as RefetchObservation);
}

export function recordRefetchObservation(db: Db, source: 'live' | 'proxy', row: RefetchObservation, nodeId: string | null): void {
  insert(db, KIND.refetchObs, source, row, nodeId);
}

export function turnHistory(db: Db, role: string): number[] {
  return rows<{ turns: number }>(db, KIND.turns, role).map((r) => r.turns).filter((t) => t > 0);
}

export function recordTurns(db: Db, role: string, turns: number, nodeId: string): void {
  if (turns > 0) insert(db, KIND.turns, role, { turns }, nodeId);
}

/** Unverified finishes that were let through, and how many then failed validation. */
export function finishBelief(db: Db): { failed: number; finished: number } {
  let failed = 0;
  let finished = 0;
  for (const r of rows<{ failed: boolean }>(db, KIND.finish, 'finish')) {
    finished++;
    if (r.failed) failed++;
  }
  return { failed, finished };
}

export function recordFinish(db: Db, failed: boolean, nodeId: string): void {
  insert(db, KIND.finish, 'finish', { failed }, nodeId);
}

export interface NegativeFinding {
  signature: string;
  /** What was searched, as the agent asked it. */
  query: string;
  nodeId: string;
  step: number;
  /** The repository revision it was true at, when known. */
  revision: string | null;
}

export function negativeFindings(db: Db, taskRootId: string): NegativeFinding[] {
  return rows<NegativeFinding>(db, KIND.negative, taskRootId);
}

export function admitNegative(db: Db, taskRootId: string, finding: NegativeFinding): void {
  insert(db, KIND.negative, taskRootId, finding, finding.nodeId);
}

/** What identical repeats into an unchanged world have done, across dispatches. */
export function repeatBelief(db: Db): RepeatBelief {
  let repeats = 0;
  let differed = 0;
  let again = 0;
  for (const r of rows<{ differed: boolean; again: boolean }>(db, KIND.repeat, 'repeat')) {
    repeats++;
    if (r.differed) differed++;
    if (r.again) again++;
  }
  return { repeats, differed, again };
}

export function recordRepeat(db: Db, row: { differed: boolean; again: boolean }, nodeId: string): void {
  insert(db, KIND.repeat, 'repeat', row, nodeId);
}
