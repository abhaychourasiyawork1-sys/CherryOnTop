/** What an execution environment *is*, as a fingerprint two runs can compare.
 *
 *  Reuse of any kind — a warm sandbox, a forked workspace, a restored snapshot
 *  — turns on one question: is the environment this run needs the same as the
 *  one that is already there? Answering it by hand at each reuse site is how a
 *  run ends up on a container built for a different lockfile. So it is answered
 *  once, here, as a hash.
 *
 *  Security is part of the identity, not a check applied afterwards. A profile
 *  that holds credentials is never equal to one that does not, whatever else
 *  matches — which is what makes "do not reuse a secret-bearing environment" a
 *  property of the fingerprint rather than a rule someone has to remember.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../context/store.js';

export type ResourceClass = 'small' | 'standard' | 'large';

export interface ExecutionProfile {
  baseImage: string;
  runtime: string;
  architecture: string;
  resourceClass: ResourceClass;
  /** The isolation class this runs under. Part of identity. */
  securityClass: string;
  networkPolicy: string;
  /** Hash of the toolchain: language versions, installed binaries. */
  toolchainFingerprint: string;
  /** Hash of the dependency manifest and lockfile. */
  dependencyFingerprint: string;
  /** True when this environment was given credentials. A profile that carries
   *  secrets is never interchangeable with one that does not. */
  bearsCredentials: boolean;
  tenant: string;
}

export const DEFAULT_PROFILE: Omit<ExecutionProfile, 'toolchainFingerprint' | 'dependencyFingerprint'> = {
  baseImage: 'cherryontop-runner:local',
  runtime: 'claude-code',
  architecture: process.arch,
  resourceClass: 'standard',
  securityClass: 'sandboxed-egress-allowlist',
  networkPolicy: 'org-egress-default',
  bearsCredentials: true,
  tenant: 'local',
};

/** A stable name for this environment. Every field participates; nothing is
 *  "close enough". */
export function profileFingerprint(profile: ExecutionProfile): string {
  return createHash('sha256').update(canonicalJson(profile)).digest('hex').slice(0, 32);
}

/** Hash of whatever identifies a toolchain or a dependency set. Callers pass
 *  the bytes they have — a lockfile, a `node --version` — rather than this
 *  module guessing where they live. */
export function fingerprintOf(parts: Record<string, string>): string {
  return createHash('sha256').update(canonicalJson(parts)).digest('hex').slice(0, 32);
}

/** How a run may use an existing environment.
 *
 *  Ordered by how much is shared, most to least. `FRESH` is not a failure — it
 *  is the correct answer whenever nothing can be shown to be safe, and every
 *  other mode falls back to it. */
export type ReuseMode = 'EXACT_REUSE' | 'FORK' | 'SNAPSHOT_RESTORE' | 'FRESH';

export interface ReuseDecision {
  mode: ReuseMode;
  reason: string;
}

export interface ReuseInput {
  wanted: ExecutionProfile;
  available?: ExecutionProfile;
  /** Whether the two want the same repository revision. */
  sameRevision: boolean;
  /** Whether the available environment has uncommitted state from another run. */
  dirty: boolean;
  /** Whether a snapshot of the wanted profile exists. */
  snapshotAvailable?: boolean;
}

/** Which reuse mode is safe. Conservative by construction: every path that
 *  cannot prove safety returns `FRESH`. */
export function decideReuse(input: ReuseInput): ReuseDecision {
  if (!input.available) {
    return input.snapshotAvailable
      ? { mode: 'SNAPSHOT_RESTORE', reason: 'no live environment, but a snapshot of this exact profile exists' }
      : { mode: 'FRESH', reason: 'nothing to reuse' };
  }

  // Credentials first, before anything about revisions or fingerprints. An
  // environment that was handed a secret is not a generic resource, and no
  // amount of matching elsewhere makes it one.
  if (input.available.bearsCredentials) {
    return { mode: 'FRESH', reason: 'the available environment was given credentials, so it is not reusable by another run' };
  }
  if (input.available.tenant !== input.wanted.tenant) {
    return { mode: 'FRESH', reason: 'the available environment belongs to another tenant' };
  }
  if (profileFingerprint(input.available) !== profileFingerprint(input.wanted)) {
    return { mode: 'FRESH', reason: 'the available environment is a different profile' };
  }

  if (input.dirty) {
    // Same environment, someone else's changes in it. A fork gives this run an
    // isolated overlay over the shared immutable base — the whole point of
    // forking rather than waiting.
    return { mode: 'FORK', reason: 'the environment matches but carries another run\'s changes, so fork an isolated overlay' };
  }
  if (!input.sameRevision) {
    return { mode: 'FORK', reason: 'the environment matches but is at a different revision' };
  }
  return { mode: 'EXACT_REUSE', reason: 'same profile, same revision, nothing in the way' };
}
