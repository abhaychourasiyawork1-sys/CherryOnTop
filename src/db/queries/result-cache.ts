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
 *
 *  Validity is dependency-based rather than keyed on the commit. Keying on HEAD
 *  is correct and blunt: one commit to a README would invalidate every cached
 *  answer about every module, and in a repository anyone is working in that is
 *  a cache that never hits. What decides instead is whether the files the run
 *  actually read still say what they said — see context/dependencies.ts, which
 *  builds that set from the run's own event stream and falls back to an exact
 *  HEAD match whenever it cannot account for what was read.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { memory } from '../schema.js';
import type { DependencyFingerprint } from '../../context/dependencies.js';

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
  /** What the answer depends on. The caller revalidates it against the current
   *  tree — this module stores and returns it, and does not decide what is
   *  still true about a repository it cannot see. */
  deps: DependencyFingerprint;
}

/** Every input that identifies the *question*. The commit is deliberately not
 *  among them — what makes an answer still true is its dependencies, checked on
 *  read, not the revision it was produced at. The grant is sorted, because two
 *  identical grants listed in different orders are the same authority and
 *  should not miss each other. */
export function resultCacheKey(
  goal: string,
  model: string,
  allowedTools: string[] | null,
): string {
  // `*` rather than '' for an unrestricted grant: an explicit sentinel cannot
  // collide with a node granted the single empty-string tool.
  const grant = allowedTools === null ? '*' : [...allowedTools].sort().join(',');
  return createHash('sha256').update(`${goal}\0${model}\0${grant}`).digest('hex');
}

/** The newest stored answer for this key that is within `ttlHours` **and**
 *  still valid. Any miss, malformed row, empty answer or disabled cache returns
 *  null and the caller dispatches normally.
 *
 *  `isValid` is asked per row, newest first, rather than only of the newest:
 *  an answer given at a commit the tree has since moved past can be stale while
 *  an older one — taken against files nothing has touched — is still true. TTL
 *  is the safety bound here, not the invalidation mechanism. */
export function getCachedResult(
  db: Db,
  key: string,
  ttlHours: number,
  isValid: (value: CachedResult) => boolean = () => true,
  now: Date = new Date(),
): CachedResult | null {
  if (ttlHours <= 0) return null;
  const rows = db.select().from(memory)
    .where(and(eq(memory.kind, KIND), eq(memory.key, key)))
    .all()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  for (const row of rows) {
    const ageMs = now.getTime() - Date.parse(row.createdAt);
    // Sorted newest first, so the first row past the TTL means every later one
    // is too.
    if (!Number.isFinite(ageMs) || ageMs > ttlHours * 3_600_000) return null;

    const value = row.value as Partial<CachedResult> | null;
    // An empty answer is not an answer. Serving one would replace a run that
    // would have said something with a node that says nothing, which is a
    // regression dressed as a cache hit.
    if (typeof value?.text !== 'string' || !value.text.trim()) continue;
    const candidate: CachedResult = {
      text: value.text,
      tokens: typeof value.tokens === 'number' ? value.tokens : 0,
      costUsd: typeof value.costUsd === 'number' ? value.costUsd : 0,
      deps: value.deps as DependencyFingerprint,
    };
    if (isValid(candidate)) return candidate;
  }
  return null;
}

export function putCachedResult(db: Db, key: string, value: CachedResult, createdAt: string): void {
  db.insert(memory).values({
    id: randomUUID(), kind: KIND, key, value, confidence: null, nodeId: null, createdAt,
  }).run();
}
