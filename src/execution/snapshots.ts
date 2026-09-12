/** Metadata for a reusable workspace, without committing to a backend.
 *
 *  The plan asks for snapshot *contracts* before any snapshot runtime, and that
 *  ordering is right: the identity of a reusable workspace is a design question,
 *  and the storage behind it is an operational one. Getting the identity wrong
 *  means restoring the wrong tree; getting the storage wrong means it is slow.
 *
 *  Nothing here writes a filesystem image. A snapshot record points at whatever
 *  holds the bytes — today a git revision, tomorrow a copy-on-write volume —
 *  and says precisely what it is a snapshot *of*.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../context/store.js';
import { profileFingerprint, type ExecutionProfile } from './profile.js';

export interface WorkspaceSnapshot {
  snapshotId: string;
  executionProfile: ExecutionProfile;
  repoRevision: string;
  /** Hash of uncommitted state. Empty when the tree was clean, which is the
   *  only case a snapshot is safely shareable between runs. */
  dirtyStateHash: string;
  /** Where the bytes are. A semantic identity, resolved by whatever backend is
   *  configured — deliberately not a path. */
  filesystemRef: string;
  createdAt: string;
  tenant: string;
}

export function snapshotId(input: {
  profile: ExecutionProfile;
  repoRevision: string;
  dirtyStateHash: string;
}): string {
  return createHash('sha256').update(canonicalJson({
    profile: profileFingerprint(input.profile),
    revision: input.repoRevision,
    dirty: input.dirtyStateHash,
  })).digest('hex').slice(0, 32);
}

export function buildSnapshot(input: {
  profile: ExecutionProfile;
  repoRevision: string;
  dirtyStateHash?: string;
  filesystemRef: string;
  createdAt: string;
}): WorkspaceSnapshot {
  const dirtyStateHash = input.dirtyStateHash ?? '';
  return {
    snapshotId: snapshotId({ profile: input.profile, repoRevision: input.repoRevision, dirtyStateHash }),
    executionProfile: input.profile,
    repoRevision: input.repoRevision,
    dirtyStateHash,
    filesystemRef: input.filesystemRef,
    createdAt: input.createdAt,
    tenant: input.profile.tenant,
  };
}

export interface SnapshotValidity {
  usable: boolean;
  reason: string;
}

/** Whether a snapshot may serve this request.
 *
 *  Refuses on anything it cannot prove, in this order: tenant, credentials,
 *  profile, revision, dirtiness. Ordered so the security answers come first and
 *  a caller reading the reason learns the most serious objection rather than
 *  the first cosmetic one. */
export function snapshotUsableFor(
  snapshot: WorkspaceSnapshot,
  wanted: { profile: ExecutionProfile; repoRevision: string },
): SnapshotValidity {
  if (snapshot.tenant !== wanted.profile.tenant) {
    return { usable: false, reason: 'the snapshot belongs to another tenant' };
  }
  if (snapshot.executionProfile.bearsCredentials) {
    return { usable: false, reason: 'the snapshot was taken of an environment holding credentials' };
  }
  if (profileFingerprint(snapshot.executionProfile) !== profileFingerprint(wanted.profile)) {
    return { usable: false, reason: 'the snapshot is of a different execution profile' };
  }
  if (snapshot.repoRevision !== wanted.repoRevision) {
    return { usable: false, reason: 'the snapshot is of a different repository revision' };
  }
  if (snapshot.dirtyStateHash !== '') {
    return { usable: false, reason: 'the snapshot captured another run\'s uncommitted changes' };
  }
  return { usable: true, reason: 'same tenant, profile and revision, with a clean tree' };
}
