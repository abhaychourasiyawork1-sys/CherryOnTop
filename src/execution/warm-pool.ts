/** Whether keeping an environment warm is worth what it costs to keep.
 *
 *  Policy only. Nothing here starts, stops or holds a container — this answers
 *  the economic question, and the runtime that acts on it is gated behind a flag
 *  that is off until a measurement says otherwise (`ORG_WARM_POOL`). That
 *  ordering is the plan's own instruction and the right one: a warm pool is a
 *  bill that arrives whether or not the reuse it was bought for happens.
 *
 *  The arithmetic is one line and it is the whole feature:
 *
 *      keep warm  ⟺  P(reuse) × startup cost avoided  >  idle cost of waiting
 *
 *  Everything else here is the safety gate in front of it.
 */
import { profileFingerprint, type ExecutionProfile } from './profile.js';

export interface WarmPoolPolicy {
  /** How likely this profile is to be asked for again inside the window. */
  reuseProbability: number;
  /** What a cold start costs, in seconds of wall clock. */
  startupSeconds: number;
  /** What holding one idle costs per second, in the same currency as the
   *  saving. Expressed in seconds of equivalent spend so the comparison needs
   *  no exchange rate. */
  idleCostPerSecond: number;
  /** How long we would hold it before giving up. */
  retentionSeconds: number;
}

export interface WarmDecision {
  keepWarm: boolean;
  /** Expected seconds saved minus expected seconds paid. Positive means keep. */
  netSeconds: number;
  reason: string;
}

/** Hard gates, before any arithmetic. A pool that can be reasoned into holding
 *  a secret-bearing environment is not a pool, it is an incident. */
export function warmPoolEligible(profile: ExecutionProfile): { eligible: boolean; reason: string } {
  if (profile.bearsCredentials) {
    return { eligible: false, reason: 'environments holding credentials are never pooled for generic reuse' };
  }
  if (profile.securityClass === 'privileged') {
    return { eligible: false, reason: 'privileged environments are never pooled' };
  }
  return { eligible: true, reason: 'no security gate applies' };
}

export function decideWarmRetention(profile: ExecutionProfile, policy: WarmPoolPolicy): WarmDecision {
  const gate = warmPoolEligible(profile);
  if (!gate.eligible) return { keepWarm: false, netSeconds: 0, reason: gate.reason };

  const saved = Math.max(0, Math.min(1, policy.reuseProbability)) * policy.startupSeconds;
  const paid = policy.retentionSeconds * policy.idleCostPerSecond;
  const netSeconds = saved - paid;

  return {
    keepWarm: netSeconds > 0,
    netSeconds,
    reason: netSeconds > 0
      ? `expected to save ${saved.toFixed(1)}s against ${paid.toFixed(1)}s of idle cost`
      : `expected to save ${saved.toFixed(1)}s against ${paid.toFixed(1)}s of idle cost — not worth holding`,
  };
}

export interface PoolTarget {
  profileFingerprint: string;
  /** How many to hold. Zero is the normal answer and must stay reachable:
   *  scale-to-zero is what stops a pool from becoming a standing bill. */
  instances: number;
  reason: string;
}

/** How many instances of a profile to keep, given recent demand.
 *
 *  Capped at the observed concurrent demand, never above it: a pool larger than
 *  the peak it has ever served is holding environments for work that has never
 *  existed. */
export function poolTarget(input: {
  profile: ExecutionProfile;
  policy: WarmPoolPolicy;
  /** The most concurrent runs of this profile seen in the window. */
  peakConcurrency: number;
  enabled: boolean;
}): PoolTarget {
  const fingerprint = profileFingerprint(input.profile);
  if (!input.enabled) {
    return { profileFingerprint: fingerprint, instances: 0, reason: 'warm pools are not enabled' };
  }

  const decision = decideWarmRetention(input.profile, input.policy);
  if (!decision.keepWarm) {
    return { profileFingerprint: fingerprint, instances: 0, reason: decision.reason };
  }

  const instances = Math.max(0, Math.floor(input.peakConcurrency));
  return {
    profileFingerprint: fingerprint,
    instances,
    reason: instances === 0
      ? 'no concurrent demand has been observed for this profile'
      : `${decision.reason}, at the observed peak of ${instances}`,
  };
}
