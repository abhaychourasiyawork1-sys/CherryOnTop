/** Storing and finding what a previous run learned.
 *
 *  Three operations and one rule. The operations are put, query and supersede.
 *  The rule is that **retrieval must be cheap and bounded**, because the whole
 *  claim of cross-run knowledge is that reading it beats re-deriving it — and a
 *  retrieval that scans everything the organization has ever learned loses that
 *  argument before the first token is saved.
 *
 *  So every query is scoped to a repository, indexed on the two columns readers
 *  actually filter by, and takes a mandatory limit. There is no "get
 *  everything": an unbounded read is not a feature this store has.
 *
 *  Ranking is deterministic and stated rather than scored, because a reader has
 *  to be able to explain why it believed something:
 *
 *   1. same revision before a different one — the only thing that makes a
 *      `fact` checkable;
 *   2. validated before asserted;
 *   3. overlap with what was asked for;
 *   4. newer before older;
 *   5. id, so two runs never disagree about the order. */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, desc } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { knowledge, evidenceConflicts } from '../db/schema.js';
import { clamp01 } from '../efficiency/policy-types.js';
import type { EvidenceConflict, KnowledgeItem, KnowledgeQuery } from './types.js';

export type { EvidenceConflict, KnowledgeItem, KnowledgeQuery };

/** The most any single query may return, whatever it asks for.
 *
 *  A ceiling on the caller's ceiling. The limit is the caller's business; that
 *  there *is* one is not, because a retrieval sized by whoever calls it is a
 *  retrieval that will eventually be sized by a bug. */
export const MAX_QUERY_LIMIT = 100;

type Row = typeof knowledge.$inferSelect;

function toItem(row: Row): KnowledgeItem {
  return {
    id: row.id,
    kind: row.kind as KnowledgeItem['kind'],
    content: row.content,
    repository: row.repository,
    revision: row.revision,
    sourcePaths: row.sourcePaths ?? [],
    sourceSymbols: row.sourceSymbols ?? [],
    confidence: row.confidence,
    validated: row.validated,
    ...(row.supersedes ? { supersedes: row.supersedes } : {}),
    ...(row.invalidatedAt ? { invalidatedAt: row.invalidatedAt } : {}),
    createdAt: row.createdAt,
  };
}

export interface PutKnowledgeInput {
  kind: KnowledgeItem['kind'];
  content: string;
  repository: string;
  revision: string;
  sourcePaths?: string[];
  sourceSymbols?: string[];
  confidence: number;
  validated?: boolean;
  supersedes?: string;
  createdAt?: string;
  /** Supplied only by tests that need a predictable id. */
  id?: string;
}

/** Writes one item, and retires what it replaces in the same breath.
 *
 *  Atomic on purpose: a superseding item stored without its predecessor being
 *  marked would leave two live answers to one question, and a reader would have
 *  no way to tell which was meant. */
export function putKnowledge(db: Db, input: PutKnowledgeInput): KnowledgeItem {
  const item: KnowledgeItem = {
    id: input.id ?? randomUUID(),
    kind: input.kind,
    content: input.content,
    repository: input.repository,
    revision: input.revision,
    sourcePaths: [...new Set(input.sourcePaths ?? [])].sort(),
    sourceSymbols: [...new Set(input.sourceSymbols ?? [])].sort(),
    confidence: clamp01(input.confidence),
    validated: input.validated === true,
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };

  db.transaction((tx) => {
    tx.insert(knowledge).values({
      ...item,
      supersedes: item.supersedes ?? null,
      invalidatedAt: null,
    }).run();
    if (item.supersedes) {
      tx.update(knowledge)
        .set({ invalidatedAt: item.createdAt })
        .where(eq(knowledge.id, item.supersedes))
        .run();
    }
  });

  return item;
}

/** Withdraws an item. Not a delete: what was believed, and when, is how a
 *  contradiction gets diagnosed rather than merely observed. */
export function invalidateKnowledge(db: Db, id: string, at = new Date().toISOString()): void {
  db.update(knowledge).set({ invalidatedAt: at }).where(eq(knowledge.id, id)).run();
}

/** How well an item answers what was asked for, on [0,1].
 *
 *  Overlap of paths and symbols. A query that named neither is asking for
 *  anything about the repository, and everything overlaps equally — which is
 *  why this returns a neutral 0.5 rather than 0 there: scoring it 0 would make
 *  the ordering fall through to recency alone and hide the validated items. */
function overlapWith(item: KnowledgeItem, query: KnowledgeQuery): number {
  const wanted = [...(query.paths ?? []), ...(query.symbols ?? [])];
  if (wanted.length === 0) return 0.5;
  const held = new Set([...item.sourcePaths, ...item.sourceSymbols]);
  return wanted.filter((value) => held.has(value)).length / wanted.length;
}

/** What this store knows that bears on the question, best first.
 *
 *  Bounded twice — by the caller's limit and by this module's ceiling — and
 *  scoped to one repository, which is the only scope a query can have. */
export function queryKnowledge(db: Db, query: KnowledgeQuery): KnowledgeItem[] {
  const limit = Math.max(0, Math.min(MAX_QUERY_LIMIT, Math.floor(query.limit)));
  if (limit === 0) return [];

  const conditions = [eq(knowledge.repository, query.repository)];
  if (!query.includeInvalidated) conditions.push(isNull(knowledge.invalidatedAt));

  const rows = db.select().from(knowledge)
    .where(and(...conditions))
    .orderBy(desc(knowledge.createdAt))
    // Read a bounded window rather than the whole repository's history: the
    // ranking below needs more than SQL can express, and reading everything to
    // sort it would be the unbounded scan this module exists to avoid.
    .limit(MAX_QUERY_LIMIT * 4)
    .all();

  const kinds = query.kinds ? new Set(query.kinds) : null;
  const scored = rows
    .map(toItem)
    .filter((item) => !kinds || kinds.has(item.kind))
    .map((item) => ({ item, overlap: overlapWith(item, query) }))
    // A query that named paths or symbols and got no overlap has been answered
    // with something about a different part of the repository.
    .filter(({ overlap }) => overlap > 0);

  scored.sort((a, b) => {
    const revisionA = query.revision && a.item.revision === query.revision ? 1 : 0;
    const revisionB = query.revision && b.item.revision === query.revision ? 1 : 0;
    if (revisionA !== revisionB) return revisionB - revisionA;
    if (a.item.validated !== b.item.validated) return a.item.validated ? -1 : 1;
    if (a.overlap !== b.overlap) return b.overlap - a.overlap;
    if (a.item.createdAt !== b.item.createdAt) return a.item.createdAt < b.item.createdAt ? 1 : -1;
    return a.item.id < b.item.id ? -1 : 1;
  });

  return scored.slice(0, limit).map(({ item }) => item);
}

export function getKnowledge(db: Db, id: string): KnowledgeItem | null {
  const row = db.select().from(knowledge).where(eq(knowledge.id, id)).get();
  return row ? toItem(row) : null;
}

// ---------------------------------------------------------------- conflicts

/** Records that two items cannot both be right.
 *
 *  Recording rather than resolving. Which of two contradictory claims is true
 *  is a question about the repository, and a store that answered it
 *  automatically would be picking silently — usually the newer one, which is
 *  right often enough to hide the times it is not. */
export function recordConflict(
  db: Db,
  input: { evidenceIds: string[]; reason: string; severity: EvidenceConflict['severity']; createdAt?: string },
): EvidenceConflict {
  const conflict: EvidenceConflict = {
    id: randomUUID(),
    evidenceIds: [...new Set(input.evidenceIds)].sort(),
    reason: input.reason,
    severity: input.severity,
    resolved: false,
  };
  db.insert(evidenceConflicts).values({
    ...conflict,
    createdAt: input.createdAt ?? new Date().toISOString(),
  }).run();
  return conflict;
}

export function resolveConflict(db: Db, id: string): void {
  db.update(evidenceConflicts).set({ resolved: true }).where(eq(evidenceConflicts.id, id)).run();
}

export function listConflicts(db: Db, options: { includeResolved?: boolean } = {}): EvidenceConflict[] {
  const rows = options.includeResolved
    ? db.select().from(evidenceConflicts).all()
    : db.select().from(evidenceConflicts).where(eq(evidenceConflicts.resolved, false)).all();
  return rows
    .map((row) => ({
      id: row.id,
      evidenceIds: row.evidenceIds ?? [],
      reason: row.reason,
      severity: row.severity as EvidenceConflict['severity'],
      resolved: row.resolved,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}
