/** A finished read-only dispatch's answer, keyed so it can be served again.
 *
 *  The plan cache already proves the validity rule: the same goal against the
 *  same committed tree produces the same answer, and a dirty tree is not
 *  keyable at all. This applies it one level up — to the answer itself rather
 *  than to the decision about how to split the work — which is where the money
 *  is. A cached plan saves a planning sandbox measured at $0.045; a cached
 *  read-only execution saves one measured at $0.95.
 *
 *  Strictly read-only dispatches. Caching the answer of a run that *changed*
 *  something would skip the change and report it as done, which is not a saving
 *  but a lie. Read-only is what makes "we did not re-run it" equivalent to "we
 *  re-ran it": there were no side effects to lose.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { memory } from '../schema.js';

const KIND = 'execution_result';

export interface CachedResult {
  /** The runtime's final result text, verbatim — including the structured
   *  envelope block, so a parent reading it back gets exactly what the original
   *  run reported. */
  text: string;
  /** What the original run cost, so a hit can say what it saved rather than
   *  guess. Input + output as the runtime billed them. */
  tokens: number;
  costUsd: number;
}

/** Every input that could change the answer. The grant is sorted, because two
 *  identical grants listed in different orders are the same authority and
 *  should not miss each other. */
export function resultCacheKey(
  goal: string,
  head: string,
  model: string,
  allowedTools: string[] | null,
): string {
  // `*` rather than '' for an unrestricted grant: an explicit sentinel cannot
  // collide with a node granted the single empty-string tool.
  const grant = allowedTools === null ? '*' : [...allowedTools].sort().join(',');
  return createHash('sha256').update(`${goal}\0${head}\0${model}\0${grant}`).digest('hex');
}

/** The stored answer for this key, if one was written within `ttlHours`. Any
 *  miss, malformed row, empty answer or disabled cache returns null and the
 *  caller dispatches normally. */
export function getCachedResult(db: Db, key: string, ttlHours: number, now: Date = new Date()): CachedResult | null {
  if (ttlHours <= 0) return null;
  const row = db.select().from(memory)
    .where(and(eq(memory.kind, KIND), eq(memory.key, key)))
    .all()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  if (!row) return null;

  const ageMs = now.getTime() - Date.parse(row.createdAt);
  if (!Number.isFinite(ageMs) || ageMs > ttlHours * 3_600_000) return null;

  const value = row.value as Partial<CachedResult> | null;
  // An empty answer is not an answer. Serving one would replace a run that
  // would have said something with a node that says nothing, which is a
  // regression dressed as a cache hit.
  if (typeof value?.text !== 'string' || !value.text.trim()) return null;
  return {
    text: value.text,
    tokens: typeof value.tokens === 'number' ? value.tokens : 0,
    costUsd: typeof value.costUsd === 'number' ? value.costUsd : 0,
  };
}

export function putCachedResult(db: Db, key: string, value: CachedResult, createdAt: string): void {
  db.insert(memory).values({
    id: randomUUID(), kind: KIND, key, value, confidence: null, nodeId: null, createdAt,
  }).run();
}
