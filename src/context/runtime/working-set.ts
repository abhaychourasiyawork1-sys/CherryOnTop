/** What a task's dispatches have already been shown, as a projection of the
 *  task manifest with policy applied.
 *
 *  This replaces a process-local `Map<head, Set<path>>` that every dispatch on a
 *  commit shared with every *other task* on that commit. That was a hint that
 *  could not contaminate an answer (it only made the selector prefer paths), but
 *  it was invisible, lost on restart, unaware of the grant a dispatch ran under,
 *  and blind to which task a path belonged to. Here the same fact is:
 *
 *   - **scoped to a task** — siblings in one delegation tree share it, other
 *     tasks never see it;
 *   - **revision-safe by construction** — the repository revision is part of
 *     each ref's identity, so a path recorded at one commit cannot be mistaken
 *     for one at another;
 *   - **scope-checked** — a ref recorded under a broader grant is not offered
 *     to a narrower consumer (`scopePermits`, the same rule every context reuse
 *     obeys);
 *   - **references, never bytes** — what comes back is paths and refs. Whether
 *     any content follows is the compiler's decision under the prompt budget.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../../db/client.js';
import { getContextObject, getLatest, putContextObject } from '../store.js';
import { scopePermits, type ContextRef, type SecurityScope } from '../types.js';
import { canonicalJson } from '../store.js';
import { applyManifestDelta, getManifest } from './task-context-manifest.js';
import type { ManifestUpdate } from './manifest-types.js';

function scopeDigest(scope: SecurityScope): string {
  return createHash('sha256').update(canonicalJson(scope)).digest('hex').slice(0, 8);
}

/** `repo_file:<path>@<revision>|<scope>` — revision and grant are part of the
 *  identity, so neither a later commit nor a different grant can alias it. */
export function repoFileId(path: string, revision: string, scope: SecurityScope): string {
  return `repo_file:${path}@${revision}|${scopeDigest(scope)}`;
}

export function parseRepoFileId(semanticId: string): { path: string; revision: string; scope: string } | null {
  if (!semanticId.startsWith('repo_file:')) return null;
  const body = semanticId.slice('repo_file:'.length);
  const bar = body.lastIndexOf('|');
  const at = body.lastIndexOf('@', bar === -1 ? undefined : bar);
  if (bar === -1 || at === -1) return null;
  return { path: body.slice(0, at), revision: body.slice(at + 1, bar), scope: body.slice(bar + 1) };
}

export interface RecordWorkingSetInput {
  revision: string;
  scope: SecurityScope;
  paths: Array<{ path: string; tokens?: number }>;
}

/** Records that these repository paths were shown to a dispatch of this task,
 *  as one manifest revision. Idempotent: a path already recorded at this
 *  revision and scope changes nothing. */
export function recordWorkingSet(db: Db, taskId: string, input: RecordWorkingSetInput): ManifestUpdate {
  const refs: ContextRef[] = input.paths.map(({ path, tokens }) => putContextObject(db, {
    semanticId: repoFileId(path, input.revision, input.scope),
    kind: 'repo_file',
    content: `${path}@${input.revision}`,
    source: { kind: 'repo', locator: path },
    ...(tokens !== undefined ? { tokens } : {}),
    scope: input.scope,
    // A file's description is true of the commit it was read at and no other.
    reusePolicy: 'EXACT',
  }).ref);
  return applyManifestDelta(db, taskId, { add: { workingSet: refs }, repositoryRevision: input.revision });
}

export interface WorkingSetConsumer {
  revision: string;
  scope: SecurityScope;
}

export interface ExcludedRef { ref: ContextRef; reason: 'other_revision' | 'scope' | 'not_valid' | 'superseded' }

export interface WorkingSetProjection {
  refs: ContextRef[];
  /** Sorted, unique. What the selector treats as "already shown". */
  paths: string[];
  excluded: ExcludedRef[];
}

/** What this consumer may be told its task already saw. Total: no manifest, an
 *  unreadable store or a malformed entry yields less, never an error. */
export function projectWorkingSet(db: Db, taskId: string, consumer: WorkingSetConsumer): WorkingSetProjection {
  const out: WorkingSetProjection = { refs: [], paths: [], excluded: [] };
  try {
    const manifest = getManifest(db, taskId);
    if (!manifest) return out;
    const paths = new Set<string>();
    for (const ref of manifest.workingSet) {
      const id = parseRepoFileId(ref.semanticId);
      if (!id) continue;
      if (id.revision !== consumer.revision) { out.excluded.push({ ref, reason: 'other_revision' }); continue; }
      const object = getContextObject(db, ref);
      if (!object || object.freshness !== 'VALID') { out.excluded.push({ ref, reason: 'not_valid' }); continue; }
      const latest = getLatest(db, ref.semanticId);
      if (latest && latest.ref.version > ref.version) { out.excluded.push({ ref, reason: 'superseded' }); continue; }
      if (!scopePermits(object.scope, consumer.scope)) { out.excluded.push({ ref, reason: 'scope' }); continue; }
      out.refs.push(ref);
      paths.add(id.path);
    }
    out.paths = [...paths].sort();
  } catch (err) {
    console.error(`Failed to project the working set of task ${taskId}:`, err);
    return { refs: [], paths: [], excluded: [] };
  }
  return out;
}
