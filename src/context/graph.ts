/** Queries over the context store's typed edges.
 *
 *  A relational store, deliberately — the plan's own constraint, and the right
 *  call at this scale: the whole graph is one `memory` scan and the traversals
 *  below are bounded by depth rather than by fan-out. A graph database here
 *  would be infrastructure bought before the query that needs it exists.
 *
 *  Two rules shape every function here:
 *
 *   - **Scope filters before ranking, never after.** Ranking first and filtering
 *     second leaks the existence of objects a consumer may not see, through the
 *     ordering and the count of what survives.
 *   - **Metadata answers metadata questions.** Nothing in this module
 *     materializes content. Deciding *whether* to look at something must not
 *     cost what looking at it costs.
 */
import type { Db } from '../db/client.js';
import { listContextObjects, getContextObject, getLatest } from './store.js';
import {
  type ContextObject, type ContextRef, type ContextKind, type EdgeKind,
  type SecurityScope, scopePermits,
} from './types.js';

/** What `inspect` answers: everything about an object except its content. */
export interface ContextInspection {
  ref: ContextRef;
  kind: ContextKind;
  tokens: number;
  freshness: ContextObject['freshness'];
  reusePolicy: ContextObject['reusePolicy'];
  scope: SecurityScope;
  source: ContextObject['source'];
  /** How many versions this semantic identity has, and whether this is the
   *  newest. The cheap way to ask "am I holding something out of date?". */
  versions: number;
  latest: boolean;
  dependencyCount: number;
  dependentCount: number;
}

const sameRef = (a: ContextRef, b: ContextRef): boolean =>
  a.semanticId === b.semanticId && a.contentHash === b.contentHash;

/** Everything the consumer is permitted to see. The first step of every query
 *  in this module. */
function visible(db: Db, scope: SecurityScope): ContextObject[] {
  return listContextObjects(db).filter((object) => scopePermits(object.scope, scope));
}

/** The objects `ref` points at, optionally of one edge kind. */
export function dependenciesOf(
  db: Db,
  ref: ContextRef,
  scope: SecurityScope,
  kind?: EdgeKind,
): ContextObject[] {
  const object = getContextObject(db, ref);
  if (!object || !scopePermits(object.scope, scope)) return [];
  return object.dependencies
    .filter((edge) => kind === undefined || edge.kind === kind)
    .map((edge) => getContextObject(db, edge.ref))
    .filter((o): o is ContextObject => o !== undefined && scopePermits(o.scope, scope));
}

/** The objects that point at `ref` — what would go stale if it changed. The
 *  query invalidation is built on. */
export function dependentsOf(
  db: Db,
  ref: ContextRef,
  scope: SecurityScope,
  kind?: EdgeKind,
): ContextObject[] {
  return visible(db, scope).filter((object) =>
    object.dependencies.some((edge) =>
      (kind === undefined || edge.kind === kind) && sameRef(edge.ref, ref)));
}

/** Transitive closure of `dependentsOf`, bounded by depth.
 *
 *  Bounded rather than exhaustive on purpose: an unbounded traversal over a
 *  graph that grows with every dispatch is an operation whose cost nobody can
 *  predict, and the answers past a few hops are rarely acted on. */
export function transitiveDependents(
  db: Db,
  ref: ContextRef,
  scope: SecurityScope,
  maxDepth = 8,
): ContextObject[] {
  const seen = new Map<string, ContextObject>();
  let frontier = [ref];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: ContextRef[] = [];
    for (const current of frontier) {
      for (const dependent of dependentsOf(db, current, scope)) {
        const key = `${dependent.ref.semanticId}\0${dependent.ref.contentHash}`;
        if (seen.has(key)) continue;
        seen.set(key, dependent);
        next.push(dependent.ref);
      }
    }
    frontier = next;
  }
  return [...seen.values()];
}

export interface SearchQuery {
  /** Free text, matched against semantic identity. Deliberately not a semantic
   *  similarity score: a single opaque number is exactly what the plan warns
   *  against, because it cannot be argued with. */
  text?: string;
  kinds?: ContextKind[];
  /** Only the newest version of each identity. */
  latestOnly?: boolean;
  /** An upper bound on total tokens across the results, not a target. */
  tokenBudget?: number;
  limit?: number;
}

function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** How many of the query's terms this identity answers to. An integer anyone
 *  can check by hand, rather than a similarity nobody can. */
function matchScore(object: ContextObject, terms: string[]): number {
  if (terms.length === 0) return 1;
  const haystack = new Set(words(object.ref.semanticId));
  return terms.filter((term) => haystack.has(term)).length;
}

/** Candidate refs for a query, scope-filtered first, then ranked, then
 *  budgeted. Returns refs rather than objects: choosing what to look at must
 *  not cost what looking at it costs. */
export function search(db: Db, query: SearchQuery, scope: SecurityScope): ContextRef[] {
  const terms = query.text ? words(query.text) : [];
  let candidates = visible(db, scope);

  if (query.kinds?.length) {
    const kinds = new Set(query.kinds);
    candidates = candidates.filter((object) => kinds.has(object.kind));
  }
  if (query.latestOnly) {
    candidates = candidates.filter((object) => {
      const latest = getLatest(db, object.ref.semanticId);
      return latest !== undefined && sameRef(latest.ref, object.ref);
    });
  }

  const scored = candidates
    .map((object) => ({ object, score: matchScore(object, terms) }))
    .filter((candidate) => candidate.score > 0)
    // Identity as the tie-break, so the same query against the same store
    // always returns the same order — what makes a projection cacheable.
    .sort((a, b) => b.score - a.score
      || a.object.tokens - b.object.tokens
      || (a.object.ref.semanticId < b.object.ref.semanticId ? -1 : 1));

  const refs: ContextRef[] = [];
  let tokens = 0;
  for (const candidate of scored) {
    if (query.limit !== undefined && refs.length >= query.limit) break;
    if (query.tokenBudget !== undefined && tokens + candidate.object.tokens > query.tokenBudget) continue;
    tokens += candidate.object.tokens;
    refs.push(candidate.object.ref);
  }
  return refs;
}

export function inspect(db: Db, ref: ContextRef, scope: SecurityScope): ContextInspection | undefined {
  const object = getContextObject(db, ref);
  if (!object || !scopePermits(object.scope, scope)) return undefined;
  const latest = getLatest(db, ref.semanticId);
  return {
    ref: object.ref,
    kind: object.kind,
    tokens: object.tokens,
    freshness: object.freshness,
    reusePolicy: object.reusePolicy,
    scope: object.scope,
    source: object.source,
    versions: latest?.ref.version ?? 0,
    latest: latest !== undefined && sameRef(latest.ref, object.ref),
    dependencyCount: object.dependencies.length,
    dependentCount: dependentsOf(db, ref, scope).length,
  };
}
