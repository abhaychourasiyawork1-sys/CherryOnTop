import { describe, it, expect } from 'vitest';
import { warmPoolEligible, decideWarmRetention, poolTarget } from './warm-pool.js';
import { DEFAULT_PROFILE, fingerprintOf, type ExecutionProfile } from './profile.js';

const profile = (over: Partial<ExecutionProfile> = {}): ExecutionProfile => ({
  ...DEFAULT_PROFILE,
  toolchainFingerprint: fingerprintOf({ node: '22' }),
  dependencyFingerprint: fingerprintOf({ lock: 'abc' }),
  bearsCredentials: false,
  ...over,
});

const policy = { reuseProbability: 0.8, startupSeconds: 30, idleCostPerSecond: 0.1, retentionSeconds: 120 };

describe('security gates come before the arithmetic', () => {
  it('never pools an environment holding credentials', () => {
    // A pool that can be reasoned into holding a secret is not a pool.
    expect(warmPoolEligible(profile({ bearsCredentials: true })).eligible).toBe(false);
    const decision = decideWarmRetention(profile({ bearsCredentials: true }), { ...policy, reuseProbability: 1, startupSeconds: 10_000 });
    expect(decision.keepWarm).toBe(false);
    expect(decision.reason).toMatch(/credentials/);
  });

  it('never pools a privileged environment', () => {
    expect(warmPoolEligible(profile({ securityClass: 'privileged' })).eligible).toBe(false);
  });
});

describe('the economics', () => {
  it('keeps an environment warm only when the expected saving exceeds the idle cost', () => {
    // 0.8 x 30s saved = 24s, against 120s x 0.1 = 12s paid.
    const worth = decideWarmRetention(profile(), policy);
    expect(worth.keepWarm).toBe(true);
    expect(worth.netSeconds).toBeCloseTo(12);

    // Rarely reused: 0.05 x 30s = 1.5s against the same 12s.
    const notWorth = decideWarmRetention(profile(), { ...policy, reuseProbability: 0.05 });
    expect(notWorth.keepWarm).toBe(false);
    expect(notWorth.reason).toMatch(/not worth holding/);
  });

  it('clamps a nonsense probability rather than trusting it', () => {
    expect(decideWarmRetention(profile(), { ...policy, reuseProbability: 5 }).netSeconds)
      .toBeCloseTo(decideWarmRetention(profile(), { ...policy, reuseProbability: 1 }).netSeconds);
  });
});

describe('pool sizing', () => {
  it('holds nothing while the feature is off, whatever the economics say', () => {
    const target = poolTarget({ profile: profile(), policy, peakConcurrency: 4, enabled: false });
    expect(target.instances).toBe(0);
    expect(target.reason).toMatch(/not enabled/);
  });

  it('scales to zero when nothing has asked for the profile', () => {
    // What stops a pool becoming a standing bill.
    expect(poolTarget({ profile: profile(), policy, peakConcurrency: 0, enabled: true }).instances).toBe(0);
  });

  it('never holds more than the peak it has actually served', () => {
    // A pool larger than the peak is holding environments for work that has
    // never existed.
    expect(poolTarget({ profile: profile(), policy, peakConcurrency: 3, enabled: true }).instances).toBe(3);
  });

  it('holds nothing for an ineligible profile even when demand is high', () => {
    const target = poolTarget({ profile: profile({ bearsCredentials: true }), policy, peakConcurrency: 10, enabled: true });
    expect(target.instances).toBe(0);
  });
});
