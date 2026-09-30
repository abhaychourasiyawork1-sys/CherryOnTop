import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { memory } from '../schema.js';

const KIND = 'plan';

export function planCacheKey(goal: string, head: string): string {
  return createHash('sha256').update(`${goal}\0${head}`).digest('hex');
}

interface PlanValue {
  subgoals: string[]; after?: number[][]; repoHead: string;
  definitionOfDone?: string[][]; acceptanceChecks?: string[][];
}

export interface CachedPlan {
  subgoals: string[]; after: number[][];
  /** Aligned with `subgoals`; empty per piece for a row written before contracts existed. */
  definitionOfDone: string[][]; acceptanceChecks: string[][];
}

/** A stored list of lists, aligned to the subgoals and safe to trust: anything
 *  malformed is an empty list for that piece, never an error. */
function listsAligned(value: unknown, count: number): string[][] {
  const lists = Array.isArray(value) ? value : [];
  return Array.from({ length: count }, (_, i) => {
    const list = lists[i];
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
  });
}

/** A previously computed subgoal list for this exact goal + committed HEAD,
 *  if one was stored within `ttlHours`. Any miss / malformed row / disabled
 *  cache returns null — the caller then plans normally. */
export function getCachedPlan(db: Db, key: string, ttlHours: number, now: Date = new Date()): CachedPlan | null {
  if (ttlHours <= 0) return null;
  const row = db.select().from(memory)
    .where(and(eq(memory.kind, KIND), eq(memory.key, key)))
    .all()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  if (!row) return null;

  const ageMs = now.getTime() - Date.parse(row.createdAt);
  if (!Number.isFinite(ageMs) || ageMs > ttlHours * 3_600_000) return null;

  const value = row.value as Partial<PlanValue> | null;
  const subgoals = value?.subgoals;
  if (!Array.isArray(subgoals) || subgoals.some((s) => typeof s !== 'string')) {
    return null;
  }
  // Rows written before ordering existed carry none: every piece ran at once.
  const after = Array.isArray(value?.after) ? value!.after : [];
  return {
    subgoals, after,
    definitionOfDone: listsAligned(value?.definitionOfDone, subgoals.length),
    acceptanceChecks: listsAligned(value?.acceptanceChecks, subgoals.length),
  };
}

export function putCachedPlan(
  db: Db, key: string, subgoals: string[], head: string, createdAt: string, after: number[][] = [],
  contracts: { definitionOfDone?: string[][]; acceptanceChecks?: string[][] } = {},
): void {
  db.insert(memory).values({
    id: randomUUID(),
    kind: KIND,
    key,
    value: {
      subgoals, after, repoHead: head,
      ...(contracts.definitionOfDone ? { definitionOfDone: contracts.definitionOfDone } : {}),
      ...(contracts.acceptanceChecks ? { acceptanceChecks: contracts.acceptanceChecks } : {}),
    } satisfies PlanValue,
    confidence: null,
    nodeId: null,
    createdAt,
  }).run();
}
