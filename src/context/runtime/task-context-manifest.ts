/** A task's context index: which refs belong to it, in which role.
 *
 *  Built on the `memory` table and the context store that already exist —
 *  nothing here holds a byte of evidence. Each revision is an immutable row
 *  (so a handoff can name "the manifest as of R10" and mean it), the latest is
 *  the one with the highest revision, and history is trimmed to a fixed
 *  window: the manifest is a derived index and losing old revisions loses no
 *  evidence, only the ability to name them.
 *
 *  The task is the *root* of a delegation tree, so a fan-out's children share
 *  one manifest. That sharing is the working set (`working-set.ts` is the
 *  policy for what of it a given consumer may see).
 *
 *  Updates are synchronous read-modify-write over a single-connection SQLite
 *  handle, so concurrent siblings in one daemon serialize on the event loop
 *  rather than racing.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { memory } from '../../db/schema.js';
import { getContextObject, getLatest, canonicalJson } from '../store.js';
import type { ContextRef } from '../types.js';
import {
  MANIFEST_SECTIONS, type ManifestDelta, type ManifestSection, type ManifestUpdate, type RejectedRef, type TaskContextManifest,
} from './manifest-types.js';

const KIND = 'task_context_manifest';

/** Old revisions kept per task. Enough to name a recent handoff; not an archive. */
export const MANIFEST_REVISIONS_KEPT = 16;

function emptyManifest(taskId: string): TaskContextManifest {
  return {
    taskId, revision: 0, contentRevision: contentRevisionOf({}), workingSet: [], facts: [], decisions: [],
    artifacts: [], validation: [], openQuestions: [], updatedAt: '',
  };
}

const byIdentity = (a: ContextRef, b: ContextRef): number =>
  a.semanticId < b.semanticId ? -1 : a.semanticId > b.semanticId ? 1 : a.version - b.version;

function contentRevisionOf(sections: Partial<Record<ManifestSection, ContextRef[]>>): string {
  const flat = MANIFEST_SECTIONS.map((section) =>
    [section, [...(sections[section] ?? [])].sort(byIdentity).map((r) => [r.semanticId, r.contentHash])]);
  return createHash('sha256').update(canonicalJson(flat)).digest('hex').slice(0, 16);
}

/** The latest manifest for a task, or null if nothing was ever recorded. */
export function getManifest(db: Db, taskId: string): TaskContextManifest | null {
  const rows = db.select().from(memory).where(and(eq(memory.kind, KIND), eq(memory.key, taskId))).all();
  let latest: TaskContextManifest | null = null;
  for (const row of rows) {
    const value = row.value as TaskContextManifest;
    if (typeof value?.revision !== 'number') continue;
    if (!latest || value.revision > latest.revision) latest = value;
  }
  return latest;
}

/** Why a ref may not be recorded, or null when it may. Checked on the way in so
 *  the manifest never holds a ref that was already wrong when it was added. */
function refusalFor(db: Db, ref: ContextRef): RejectedRef['reason'] | null {
  const object = getContextObject(db, ref);
  if (!object) return 'unknown_ref';
  if (object.freshness === 'INVALID') return 'invalid';
  if (object.freshness === 'EXPIRED') return 'expired';
  const latest = getLatest(db, ref.semanticId);
  if (latest && latest.ref.version > ref.version) return 'superseded';
  return null;
}

/** Applies one batch of additions and removals as a single revision. Total in
 *  the sense that a bad ref is rejected and reported, never thrown: the rest of
 *  the batch still lands. */
export function applyManifestDelta(
  db: Db,
  taskId: string,
  delta: ManifestDelta,
  now: () => string = () => new Date().toISOString(),
): ManifestUpdate {
  const current = getManifest(db, taskId) ?? emptyManifest(taskId);
  const rejected: RejectedRef[] = [];

  const next: Record<ManifestSection, ContextRef[]> = {
    workingSet: [...current.workingSet], facts: [...current.facts], decisions: [...current.decisions],
    artifacts: [...current.artifacts], validation: [...current.validation], openQuestions: [...current.openQuestions],
  };

  for (const section of MANIFEST_SECTIONS) {
    for (const ref of delta.remove?.[section] ?? []) {
      next[section] = next[section].filter((held) => !(held.semanticId === ref.semanticId && held.contentHash === ref.contentHash));
    }
    for (const ref of delta.add?.[section] ?? []) {
      const reason = refusalFor(db, ref);
      if (reason) { rejected.push({ section, ref, reason }); continue; }
      // One entry per identity: a newer version replaces the one it supersedes.
      next[section] = [...next[section].filter((held) => held.semanticId !== ref.semanticId), ref];
    }
    next[section].sort(byIdentity);
  }

  const contentRevision = contentRevisionOf(next);
  const repositoryRevision = delta.repositoryRevision ?? current.repositoryRevision;
  const changed = contentRevision !== current.contentRevision || repositoryRevision !== current.repositoryRevision;
  if (!changed) return { manifest: current, changed: false, rejected };

  const manifest: TaskContextManifest = {
    taskId, revision: current.revision + 1, contentRevision,
    ...(repositoryRevision ? { repositoryRevision } : {}),
    ...next, updatedAt: now(),
  };
  db.insert(memory).values({
    id: randomUUID(), kind: KIND, key: taskId, value: manifest, confidence: null, nodeId: taskId, createdAt: manifest.updatedAt,
  }).run();
  trimHistory(db, taskId, manifest.revision);
  return { manifest, changed: true, rejected };
}

function trimHistory(db: Db, taskId: string, latest: number): void {
  if (latest <= MANIFEST_REVISIONS_KEPT) return;
  const stale = db.select().from(memory).where(and(eq(memory.kind, KIND), eq(memory.key, taskId))).all()
    .filter((row) => (row.value as TaskContextManifest).revision <= latest - MANIFEST_REVISIONS_KEPT)
    .map((row) => row.id);
  if (stale.length > 0) db.delete(memory).where(inArray(memory.id, stale)).run();
}

export interface DescribedManifest {
  valid: ContextRef[];
  /** Refs that were fine when recorded and are not now, and why. */
  stale: Array<{ section: ManifestSection; ref: ContextRef; state: 'superseded' | 'invalid' | 'expired' | 'unknown_ref' }>;
}

/** Every ref in the manifest, sorted into those still true and those not. The
 *  manifest itself is never rewritten by a read: a consumer decides what to do
 *  with a stale ref, and removal is an explicit delta. */
export function describeManifest(db: Db, manifest: TaskContextManifest): DescribedManifest {
  const valid: ContextRef[] = [];
  const stale: DescribedManifest['stale'] = [];
  for (const section of MANIFEST_SECTIONS) {
    for (const ref of manifest[section]) {
      const reason = refusalFor(db, ref);
      if (reason) stale.push({ section, ref, state: reason });
      else valid.push(ref);
    }
  }
  return { valid, stale };
}

