/** Immutable, content-addressed persistence for context objects.
 *
 *  Built on the existing `memory` table rather than a new one, and on the
 *  existing `events`/`artifacts` tables for the bytes. Two consequences worth
 *  being explicit about:
 *
 *   - **No payload is copied.** An object points at the event or artifact that
 *     already holds its content. Storing a second copy would make the store a
 *     source of truth it is not entitled to be, and double what a run costs to
 *     keep.
 *   - **The store is a derived index.** Delete every row and nothing is lost
 *     that the event log cannot rebuild — a property `store.test.ts` asserts by
 *     actually deleting them.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { memory } from '../db/schema.js';
import {
  type ContextObject, type ContextRef, type ContextKind, type ContextSource,
  type DependencyRef, type FreshnessState, type ReusePolicy, type SecurityScope,
} from './types.js';

const KIND = 'context_object';

/** JSON with its keys in a fixed order, so two objects that say the same thing
 *  hash the same however they were built. Without this, content addressing is
 *  addressing by whatever order a literal happened to be written in. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** The identity of what this object *says* — content, where it came from, what
 *  it depends on and who may see it.
 *
 *  The scope is part of the hash deliberately. Two objects with identical bytes
 *  produced under different grants are not interchangeable, and a hash that
 *  could not tell them apart would let the narrower one be served in place of
 *  the wider one. */
export function contentHashOf(input: {
  content: string;
  kind: ContextKind;
  source: ContextSource;
  scope: SecurityScope;
  dependencies: DependencyRef[];
}): string {
  return createHash('sha256').update(canonicalJson({
    content: input.content,
    kind: input.kind,
    source: input.source,
    scope: input.scope,
    // Sorted, so the same dependency set declared in a different order is the
    // same dependency set.
    dependencies: [...input.dependencies]
      .map((d) => ({ kind: d.kind, id: d.ref.semanticId, hash: d.ref.contentHash }))
      .sort((a, b) => canonicalJson(a) < canonicalJson(b) ? -1 : 1),
  })).digest('hex');
}

export interface PutContextObject {
  semanticId: string;
  kind: ContextKind;
  /** The bytes this object is about. Hashed, and kept only when `source.kind`
   *  is `inline`. */
  content: string;
  source: ContextSource;
  tokens?: number;
  scope: SecurityScope;
  reusePolicy?: ReusePolicy;
  dependencies?: DependencyRef[];
  createdAt?: string;
}

const CHARS_PER_TOKEN = 4;

function rowsFor(db: Db, semanticId: string) {
  return db.select().from(memory)
    .where(and(eq(memory.kind, KIND), eq(memory.key, semanticId)))
    .all()
    .map((row) => row.value as ContextObject)
    .filter((object) => typeof object?.ref?.contentHash === 'string')
    .sort((a, b) => a.ref.version - b.ref.version);
}

/** Stores a version of a semantic identity, or returns the existing version
 *  when the content is unchanged.
 *
 *  Idempotent on content: re-observing the same file at the same bytes must not
 *  produce a second version, or every dispatch would inflate the graph without
 *  adding a fact. */
export function putContextObject(db: Db, input: PutContextObject): ContextObject {
  const dependencies = input.dependencies ?? [];
  const scope = input.scope;
  const contentHash = contentHashOf({
    content: input.content, kind: input.kind, source: input.source, scope, dependencies,
  });

  const existing = rowsFor(db, input.semanticId);
  const match = existing.find((object) => object.ref.contentHash === contentHash);
  if (match) return match;

  const object: ContextObject = {
    ref: { semanticId: input.semanticId, version: (existing.at(-1)?.ref.version ?? 0) + 1, contentHash },
    kind: input.kind,
    source: input.source,
    ...(input.source.kind === 'inline' ? { inline: input.content } : {}),
    tokens: input.tokens ?? Math.ceil(input.content.length / CHARS_PER_TOKEN),
    scope,
    reusePolicy: input.reusePolicy ?? 'SAFE_IF_DEPENDENCIES_MATCH',
    dependencies,
    freshness: 'VALID',
    createdAt: input.createdAt ?? new Date().toISOString(),
  };

  db.insert(memory).values({
    id: randomUUID(), kind: KIND, key: input.semanticId, value: object,
    confidence: null, nodeId: null, createdAt: object.createdAt,
  }).run();

  // A new version supersedes the one before it. Recorded on the *old* row so a
  // reader holding an old ref learns it has been overtaken without having to
  // scan forward for a successor.
  const previous = existing.at(-1);
  if (previous) markFreshness(db, previous.ref, 'STALE');
  return object;
}

export function getContextObject(db: Db, ref: ContextRef): ContextObject | undefined {
  return rowsFor(db, ref.semanticId).find((object) =>
    object.ref.contentHash === ref.contentHash && object.ref.version === ref.version);
}

/** The newest version of a semantic identity. */
export function getLatest(db: Db, semanticId: string): ContextObject | undefined {
  return rowsFor(db, semanticId).at(-1);
}

export function listVersions(db: Db, semanticId: string): ContextObject[] {
  return rowsFor(db, semanticId);
}

/** Every object in the store, newest version last per identity. The graph's
 *  scan, kept here so nothing else has to know the row layout. */
export function listContextObjects(db: Db): ContextObject[] {
  return db.select().from(memory).where(eq(memory.kind, KIND)).all()
    .map((row) => row.value as ContextObject)
    .filter((object) => typeof object?.ref?.contentHash === 'string');
}

/** Rewrites one object's freshness in place.
 *
 *  The one mutation this store permits, and it does not touch what the object
 *  *says* — only whether that is still believed. Content stays immutable, which
 *  is what makes a ref a permanent name for a fact. */
export function markFreshness(db: Db, ref: ContextRef, freshness: FreshnessState): void {
  const rows = db.select().from(memory)
    .where(and(eq(memory.kind, KIND), eq(memory.key, ref.semanticId)))
    .all();
  for (const row of rows) {
    const object = row.value as ContextObject;
    if (object?.ref?.contentHash !== ref.contentHash) continue;
    db.update(memory).set({ value: { ...object, freshness } }).where(eq(memory.id, row.id)).run();
  }
}

/** Removes every context object. Exported for the rebuild test, which is the
 *  only thing entitled to do this: the store is derived, and proving it is
 *  derived means being able to throw it away. */
export function clearContextObjects(db: Db): void {
  db.delete(memory).where(eq(memory.kind, KIND)).run();
}
