import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { memory } from '../schema.js';

const KIND = 'plan';

export function planCacheKey(goal: string, head: string): string {
  return createHash('sha256').update(`${goal}\0${head}`).digest('hex');
}

interface PlanValue { subgoals: string[]; repoHead: string }

/** A previously computed subgoal list for this exact goal + committed HEAD,
 *  if one was stored within `ttlHours`. Any miss / malformed row / disabled
 *  cache returns null — the caller then plans normally. */
export function getCachedPlan(db: Db, key: string, ttlHours: number, now: Date = new Date()): string[] | null {
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
  return subgoals;
}

export function putCachedPlan(db: Db, key: string, subgoals: string[], head: string, createdAt: string): void {
  db.insert(memory).values({
    id: randomUUID(),
    kind: KIND,
    key,
    value: { subgoals, repoHead: head } satisfies PlanValue,
    confidence: null,
    nodeId: null,
    createdAt,
  }).run();
}
