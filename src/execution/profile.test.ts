import { describe, it, expect } from 'vitest';
import { profileFingerprint, fingerprintOf, decideReuse, DEFAULT_PROFILE, type ExecutionProfile } from './profile.js';

const profile = (over: Partial<ExecutionProfile> = {}): ExecutionProfile => ({
  ...DEFAULT_PROFILE,
  toolchainFingerprint: fingerprintOf({ node: '22.22.2' }),
  dependencyFingerprint: fingerprintOf({ lockfile: 'abc' }),
  bearsCredentials: false,
  ...over,
});

describe('fingerprints', () => {
  it('is stable for the same environment and different for any change', () => {
    expect(profileFingerprint(profile())).toBe(profileFingerprint(profile()));
    for (const change of [
      { baseImage: 'other:tag' },
      { resourceClass: 'large' as const },
      { networkPolicy: 'open' },
      { toolchainFingerprint: fingerprintOf({ node: '20.0.0' }) },
      { dependencyFingerprint: fingerprintOf({ lockfile: 'def' }) },
      { securityClass: 'privileged' },
    ]) {
      expect(profileFingerprint(profile(change))).not.toBe(profileFingerprint(profile()));
    }
  });

  it('never equates an environment holding credentials with one that is not', () => {
    // "Do not reuse a secret-bearing environment" is a property of the
    // fingerprint, not a rule someone has to remember at each reuse site.
    expect(profileFingerprint(profile({ bearsCredentials: true })))
      .not.toBe(profileFingerprint(profile({ bearsCredentials: false })));
  });

  it('hashes whatever identifies a toolchain, regardless of key order', () => {
    expect(fingerprintOf({ node: '22', pnpm: '9' })).toBe(fingerprintOf({ pnpm: '9', node: '22' }));
  });
});

describe('choosing a reuse mode', () => {
  it('runs fresh when there is nothing to reuse', () => {
    expect(decideReuse({ wanted: profile(), sameRevision: true, dirty: false }).mode).toBe('FRESH');
  });

  it('restores a snapshot when no live environment exists but one was taken', () => {
    expect(decideReuse({ wanted: profile(), sameRevision: true, dirty: false, snapshotAvailable: true }).mode)
      .toBe('SNAPSHOT_RESTORE');
  });

  it('refuses an environment that was given credentials, before anything else is considered', () => {
    // No amount of matching elsewhere makes a secret-bearing environment a
    // generic resource.
    const decision = decideReuse({
      wanted: profile({ bearsCredentials: true }),
      available: profile({ bearsCredentials: true }),
      sameRevision: true, dirty: false,
    });
    expect(decision.mode).toBe('FRESH');
    expect(decision.reason).toMatch(/credentials/);
  });

  it('refuses another tenant’s environment', () => {
    const decision = decideReuse({
      wanted: profile(), available: profile({ tenant: 'other' }), sameRevision: true, dirty: false,
    });
    expect(decision.mode).toBe('FRESH');
    expect(decision.reason).toMatch(/another tenant/);
  });

  it('refuses a different profile however close it looks', () => {
    const decision = decideReuse({
      wanted: profile(),
      available: profile({ dependencyFingerprint: fingerprintOf({ lockfile: 'changed' }) }),
      sameRevision: true, dirty: false,
    });
    expect(decision.mode).toBe('FRESH');
    expect(decision.reason).toMatch(/different profile/);
  });

  it('forks rather than waiting when the environment matches but is in use', () => {
    expect(decideReuse({ wanted: profile(), available: profile(), sameRevision: true, dirty: true }).mode).toBe('FORK');
    expect(decideReuse({ wanted: profile(), available: profile(), sameRevision: false, dirty: false }).mode).toBe('FORK');
  });

  it('reuses exactly when nothing is in the way', () => {
    const decision = decideReuse({ wanted: profile(), available: profile(), sameRevision: true, dirty: false });
    expect(decision.mode).toBe('EXACT_REUSE');
  });
});
