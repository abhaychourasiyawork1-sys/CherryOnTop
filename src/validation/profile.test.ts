import { describe, it, expect } from 'vitest';
import { validationProfileFor, contractForProfile, meetsMinimumLevel } from './profile.js';
import { taskEconomicsFor } from '../efficiency/task-economics.js';
import type { ValidationProfileInput } from './profile.js';

function profile(over: Partial<ValidationProfileInput> = {}) {
  return validationProfileFor({
    strategy: 'MANAGED',
    economics: {
      complexityBand: 'tiny', verificationNeed: 0.4,
      readOnly: false, expectedModificationScope: 0.1,
    },
    ...over,
  });
}

describe('minimum level derivation', () => {
  it('asks a tiny managed edit only for a durable outcome', () => {
    expect(profile().minimumLevel).toBe('V1');
  });

  it('asks a normal managed change for an observed verification', () => {
    expect(profile({
      economics: { complexityBand: 'medium', verificationNeed: 0.8, readOnly: false, expectedModificationScope: 0.3 },
    }).minimumLevel).toBe('V2');
  });

  it('asks a risky managed change for an observed verification and permits a fresh one', () => {
    const risky = profile({
      economics: { complexityBand: 'large', verificationNeed: 0.8, readOnly: false, expectedModificationScope: 0.8 },
      freshVerifierAvailable: true,
    });
    expect(risky.minimumLevel).toBe('V2');
    expect(risky.freshVerificationAllowed).toBe(true);
    expect(risky.riskReasons).toContain('wide_modification_scope');
  });

  it('asks delegated work for an observed verification even when it is small', () => {
    const delegated = profile({ strategy: 'SERIAL_DELEGATED' });
    expect(delegated.minimumLevel).toBe('V2');
    expect(delegated.riskReasons).toContain('delegated_work_needs_observed_verification');
  });

  it('accepts a durable finding from a read-only investigation', () => {
    const investigation = profile({
      economics: { complexityBand: 'medium', verificationNeed: 0.3, readOnly: true, expectedModificationScope: 0 },
    });
    expect(investigation.minimumLevel).toBe('V1');
    expect(investigation.riskReasons).toContain('read_only_durable_finding');
    // Never buys a fresh verification for work that changed nothing.
    expect(investigation.freshVerificationAllowed).toBe(false);
  });

  it('raises the floor after a failed attempt', () => {
    const retried = profile({ recoveryCount: 2 });
    expect(retried.minimumLevel).toBe('V2');
    expect(retried.riskReasons).toContain('prior_attempts_failed:2');
  });
});

describe('required checks', () => {
  it('keeps explicit named checks exactly as a person wrote them', () => {
    const named = profile({ requiredChecks: ['changelog updated', 'migration reviewed'] });
    expect(named.requiredChecks).toEqual(['changelog updated', 'migration reviewed']);
    expect(contractForProfile(named).requiredChecks).toEqual(named.requiredChecks);
  });

  it('deduplicates without dropping any', () => {
    expect(profile({ requiredChecks: ['a', 'a', 'b'] }).requiredChecks).toEqual(['a', 'b']);
  });
});

describe('budget and fresh verification', () => {
  it('spends nothing when only existing evidence is required', () => {
    expect(profile().validationBudget).toBe(0);
  });

  it('spends nothing when the deployment has no verifier, however risky the task', () => {
    const noVerifier = profile({
      economics: { complexityBand: 'large', verificationNeed: 0.9, readOnly: false, expectedModificationScope: 0.9 },
    });
    expect(noVerifier.freshVerificationAllowed).toBe(false);
    expect(noVerifier.validationBudget).toBe(0);
  });

  it('keeps the confidence floor falsifiable — never 1', () => {
    expect(contractForProfile(profile({
      economics: { complexityBand: 'large', verificationNeed: 1, readOnly: false, expectedModificationScope: 1 },
    })).qualityFloor).toBeLessThan(1);
  });
});

describe('meetsMinimumLevel', () => {
  it('fails a verdict that cleared confidence but not the required level', () => {
    const delegated = profile({ strategy: 'PARALLEL_DELEGATED' });
    expect(meetsMinimumLevel(delegated, 'V1')).toBe(false);
    expect(meetsMinimumLevel(delegated, 'V2')).toBe(true);
    expect(meetsMinimumLevel(delegated, 'V3')).toBe(true);
  });

  it('never accepts V0 as a minimum for anything', () => {
    expect(meetsMinimumLevel(profile(), 'V0')).toBe(false);
  });
});

describe('derived from a real goal', () => {
  it('routes a typo fix to the cheap rung and a bug fix to the observed one', () => {
    const typo = validationProfileFor({ strategy: 'MANAGED', economics: taskEconomicsFor('Fix the typo in README.md') });
    const bug = validationProfileFor({
      strategy: 'MANAGED',
      economics: taskEconomicsFor('Fix the failing session refresh across every auth module in the repository'),
    });
    expect(typo.minimumLevel).toBe('V1');
    expect(bug.minimumLevel).toBe('V2');
  });
});
