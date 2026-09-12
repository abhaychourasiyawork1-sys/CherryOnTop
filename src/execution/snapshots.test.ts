import { describe, it, expect } from 'vitest';
import { buildSnapshot, snapshotId, snapshotUsableFor } from './snapshots.js';
import { DEFAULT_PROFILE, fingerprintOf, type ExecutionProfile } from './profile.js';

const profile = (over: Partial<ExecutionProfile> = {}): ExecutionProfile => ({
  ...DEFAULT_PROFILE,
  toolchainFingerprint: fingerprintOf({ node: '22' }),
  dependencyFingerprint: fingerprintOf({ lock: 'abc' }),
  bearsCredentials: false,
  ...over,
});

const snapshot = (over: Parameters<typeof buildSnapshot>[0] | Record<string, never> = {}) => buildSnapshot({
  profile: profile(), repoRevision: 'rev1', filesystemRef: 'snapshot:1', createdAt: 't0',
  ...over,
} as Parameters<typeof buildSnapshot>[0]);

describe('snapshot identity', () => {
  it('is the same for the same profile, revision and tree state', () => {
    expect(snapshot().snapshotId).toBe(snapshot().snapshotId);
  });

  it('changes when any of those changes', () => {
    expect(snapshot({ profile: profile(), repoRevision: 'rev2', filesystemRef: 's', createdAt: 't' }).snapshotId)
      .not.toBe(snapshot().snapshotId);
    expect(snapshotId({ profile: profile(), repoRevision: 'rev1', dirtyStateHash: 'dirty' }))
      .not.toBe(snapshotId({ profile: profile(), repoRevision: 'rev1', dirtyStateHash: '' }));
  });

  it('points at the bytes rather than owning them', () => {
    // The identity is a design question; the storage behind it is an
    // operational one, and this module only answers the first.
    expect(snapshot().filesystemRef).toBe('snapshot:1');
  });
});

describe('whether a snapshot may serve a request', () => {
  const wanted = { profile: profile(), repoRevision: 'rev1' };

  it('serves a clean snapshot of the same profile and revision', () => {
    expect(snapshotUsableFor(snapshot(), wanted).usable).toBe(true);
  });

  it('reports the most serious objection first', () => {
    // A caller reading the reason should learn about the tenant breach, not
    // about the revision.
    const crossTenant = buildSnapshot({
      profile: profile({ tenant: 'other', bearsCredentials: true }),
      repoRevision: 'rev9', filesystemRef: 's', createdAt: 't',
    });
    expect(snapshotUsableFor(crossTenant, wanted).reason).toMatch(/another tenant/);
  });

  it('never serves a snapshot taken of an environment holding credentials', () => {
    const secretBearing = buildSnapshot({
      profile: profile({ bearsCredentials: true }), repoRevision: 'rev1', filesystemRef: 's', createdAt: 't',
    });
    expect(snapshotUsableFor(secretBearing, wanted).usable).toBe(false);
  });

  it('never serves a snapshot that captured another run’s uncommitted changes', () => {
    const dirty = buildSnapshot({
      profile: profile(), repoRevision: 'rev1', dirtyStateHash: 'abc', filesystemRef: 's', createdAt: 't',
    });
    expect(snapshotUsableFor(dirty, wanted).usable).toBe(false);
    expect(snapshotUsableFor(dirty, wanted).reason).toMatch(/uncommitted/);
  });

  it('refuses a different revision', () => {
    expect(snapshotUsableFor(snapshot(), { profile: profile(), repoRevision: 'rev2' }).usable).toBe(false);
  });
});
