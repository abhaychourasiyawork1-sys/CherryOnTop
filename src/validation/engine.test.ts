import { describe, it, expect, vi } from 'vitest';
import { validate, canClaimSuccess, NO_EVIDENCE, type ValidationEvidence, type FreshVerifier } from './engine.js';
import {
  LEVEL_MODEL, VALIDATION_LEVELS, requiredConfidence, DEFAULT_VALIDATION_CONTRACT,
  contractFor, MINIMUM_QUALITY_FLOOR, MAXIMUM_DERIVED_FLOOR,
  type ValidationContract,
} from './contract.js';

const evidence = (over: Partial<ValidationEvidence> = {}): ValidationEvidence => ({ ...NO_EVIDENCE, ...over });

const contract = (over: Partial<ValidationContract> = {}): ValidationContract =>
  ({ ...DEFAULT_VALIDATION_CONTRACT, ...over });

const greenVerifier: FreshVerifier = () =>
  ({ passed: true, evidenceId: 'fresh:vitest', tokens: 2_000, latencyMs: 40_000 });
const redVerifier: FreshVerifier = () =>
  ({ passed: false, evidenceId: 'fresh:vitest', tokens: 2_000, latencyMs: 40_000 });

describe('finishing is not succeeding', () => {
  it('refuses to call a bare success claim a successful task', () => {
    const result = validate({ evidence: evidence({ claimedSuccess: true }) });
    expect(result.level).toBe('V0');
    expect(result.passed).toBe(false);
    expect(canClaimSuccess(result)).toBe(false);
    expect(result.reasonCodes).toContain('below_required_confidence');
  });

  it('refuses a claim backed only by "a file changed"', () => {
    const result = validate({
      evidence: evidence({ claimedSuccess: true, artifactIds: ['artifact-1'] }),
    });
    expect(result.level).toBe('V1');
    expect(result.passed).toBe(false);
  });

  it('refuses everything when there is no evidence at any level', () => {
    const result = validate({ evidence: evidence() });
    expect(result.passed).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.evidenceIds).toEqual([]);
    expect(result.reasonCodes).toContain('no_evidence_at_any_level');
  });

  it('says what it actually checked, so a verdict can be disputed', () => {
    const result = validate({
      evidence: evidence({
        claimedSuccess: true, artifactIds: ['a1'],
        observedChecks: [{ id: 'check-1', command: 'npm test', passed: true }],
      }),
    });
    expect(result.evidenceIds).toEqual(['check-1']);
  });
});

describe('the cheapest sufficient level', () => {
  it('accepts a green check the run already ran, and pays nothing for it', () => {
    const result = validate({
      evidence: evidence({
        claimedSuccess: true, artifactIds: ['a1'],
        observedChecks: [{ id: 'check-1', command: 'npm test', passed: true }],
      }),
      verify: vi.fn(greenVerifier),
    });
    expect(result.level).toBe('V2');
    expect(result.passed).toBe(true);
    expect(result.tokens).toBe(0);
    expect(result.latencyMs).toBe(0);
  });

  it('does not re-run a check whose evidence already clears the floor', () => {
    const verifier = vi.fn(greenVerifier);
    validate({
      evidence: evidence({
        claimedSuccess: true,
        observedChecks: [{ id: 'check-1', command: 'npm test', passed: true }],
      }),
      verify: verifier,
    });
    expect(verifier).not.toHaveBeenCalled();
  });

  it('climbs to a fresh run when the floor demands more than the trace can show', () => {
    const verifier = vi.fn(greenVerifier);
    const result = validate({
      evidence: evidence({
        claimedSuccess: true,
        observedChecks: [{ id: 'check-1', command: 'npm test', passed: true }],
      }),
      contract: contract({ qualityFloor: 0.95, allowedUncertainty: 0.05 }),
      verify: verifier,
    });
    expect(verifier).toHaveBeenCalledTimes(1);
    expect(result.level).toBe('V3');
    expect(result.passed).toBe(true);
    expect(result.tokens).toBeGreaterThan(0);
  });

  it('accumulates the cost of every level it actually paid for', () => {
    const result = validate({
      evidence: evidence({ claimedSuccess: true, observedChecks: [{ id: 'c', command: 'npm test', passed: true }] }),
      contract: contract({ qualityFloor: 0.95, allowedUncertainty: 0.05 }),
      verify: greenVerifier,
    });
    expect(result.tokens).toBe(2_000);
    expect(result.latencyMs).toBe(40_000);
  });

  it('stops at V2 when there is no way to verify freshly', () => {
    const result = validate({
      evidence: evidence({ claimedSuccess: true, observedChecks: [{ id: 'c', command: 'npm test', passed: true }] }),
      contract: contract({ qualityFloor: 0.95, allowedUncertainty: 0.05 }),
    });
    expect(result.level).toBe('V2');
    expect(result.passed).toBe(false);
    expect(result.reasonCodes).toContain('V3:no_verifier');
  });

  it('distinguishes a verifier that could not run from a check that failed', () => {
    const cannotRun = validate({
      evidence: evidence({ claimedSuccess: true, observedChecks: [{ id: 'c', command: 'npm test', passed: true }] }),
      contract: contract({ qualityFloor: 0.95, allowedUncertainty: 0.05 }),
      verify: () => null,
    });
    const ranAndFailed = validate({
      evidence: evidence({ claimedSuccess: true, observedChecks: [{ id: 'c', command: 'npm test', passed: true }] }),
      contract: contract({ qualityFloor: 0.95, allowedUncertainty: 0.05 }),
      verify: redVerifier,
    });
    expect(cannotRun.reasonCodes).toContain('V3:verifier_unavailable');
    expect(ranAndFailed.reasonCodes).toContain('V3:fresh_verification_failed');
    expect(cannotRun.level).toBe('V2');
    expect(ranAndFailed.level).toBe('V3');
  });
});

describe('false-success protection', () => {
  it('treats an observed failure as evidence against, not as a level to climb past', () => {
    const verifier = vi.fn(greenVerifier);
    const result = validate({
      evidence: evidence({
        claimedSuccess: true, artifactIds: ['a1'],
        observedChecks: [{ id: 'check-1', command: 'npm test', passed: false }],
      }),
      verify: verifier,
    });
    expect(result.passed).toBe(false);
    // Climbing further would be shopping for a verdict.
    expect(verifier).not.toHaveBeenCalled();
    expect(result.reasonCodes).toContain('V2:observed_verification_failed');
  });

  it('accepts a run that failed a check and then fixed it', () => {
    const result = validate({
      evidence: evidence({
        claimedSuccess: true,
        observedChecks: [
          { id: 'c1', command: 'npm test', passed: false },
          { id: 'c2', command: 'npm test', passed: true },
        ],
      }),
    });
    expect(result.passed).toBe(true);
    expect(result.evidenceIds).toEqual(['c2']);
  });

  it('fails a task whose named checks were never closed, however green the tests', () => {
    const result = validate({
      evidence: evidence({
        claimedSuccess: true,
        observedChecks: [{ id: 'c', command: 'npm test', passed: true }],
        requiredChecks: [
          { id: 'd1', text: 'the test passes', met: true },
          { id: 'd2', text: 'nothing else changed', met: false },
        ],
      }),
    });
    expect(result.passed).toBe(false);
    expect(result.reasonCodes).toContain('required_checks_unmet:1');
  });

  it('passes when every named check is closed', () => {
    const result = validate({
      evidence: evidence({
        claimedSuccess: true,
        observedChecks: [{ id: 'c', command: 'npm test', passed: true }],
        requiredChecks: [{ id: 'd1', text: 'the test passes', met: true }],
      }),
    });
    expect(result.passed).toBe(true);
  });

  it('never reports certainty, so the floor stays falsifiable', () => {
    const result = validate({
      evidence: evidence({ claimedSuccess: true }),
      contract: contract({ qualityFloor: 1, allowedUncertainty: 0 }),
      verify: greenVerifier,
    });
    expect(result.confidence).toBeLessThan(1);
    expect(result.passed).toBe(false);
  });
});

describe('the level model', () => {
  it('rises monotonically in confidence', () => {
    const confidences = VALIDATION_LEVELS.map((level) => LEVEL_MODEL[level].confidence);
    for (let i = 1; i < confidences.length; i++) {
      expect(confidences[i]).toBeGreaterThan(confidences[i - 1]);
    }
  });

  it('makes the free levels genuinely free', () => {
    for (const level of ['V0', 'V1', 'V2'] as const) {
      expect(LEVEL_MODEL[level].tokens).toBe(0);
      expect(LEVEL_MODEL[level].latencyMs).toBe(0);
    }
  });

  it('keeps an unsupported claim below any sane floor', () => {
    // The single most important number here: this is what stops "the process
    // exited zero" from becoming "the task succeeded".
    expect(LEVEL_MODEL.V0.confidence).toBeLessThan(DEFAULT_VALIDATION_CONTRACT.qualityFloor);
    expect(LEVEL_MODEL.V1.confidence).toBeLessThan(DEFAULT_VALIDATION_CONTRACT.qualityFloor);
  });

  it('never claims a level is proof', () => {
    for (const level of VALIDATION_LEVELS) expect(LEVEL_MODEL[level].confidence).toBeLessThan(1);
  });
});

describe('requiredConfidence', () => {
  it('takes the stricter of the floor and the uncertainty allowance', () => {
    expect(requiredConfidence(contract({ qualityFloor: 0.9, allowedUncertainty: 0.5 }))).toBeCloseTo(0.9);
    expect(requiredConfidence(contract({ qualityFloor: 0.4, allowedUncertainty: 0.05 }))).toBeCloseTo(0.95);
  });

  it('clamps nonsense rather than propagating it', () => {
    expect(requiredConfidence(contract({ qualityFloor: 5, allowedUncertainty: -2 }))).toBe(1);
  });
});

describe('the floor comes from the task, bounded where it is a guess', () => {
  it('lets a task nobody asked to verify pass on having produced something', () => {
    // The defect the benchmark exposed: at a global floor of 0.7, a task that
    // edits a file and runs no test could never pass, so tokens per
    // *successful* task was uncomputable for most of a corpus.
    const typoFix = contractFor({ verificationNeed: 0.25 });
    const result = validate({
      evidence: evidence({ claimedSuccess: true, artifactIds: ['README.md'] }),
      contract: typoFix,
    });
    expect(result.level).toBe('V1');
    expect(result.passed).toBe(true);
  });

  it('still refuses a bare claim for that same task', () => {
    const typoFix = contractFor({ verificationNeed: 0.25 });
    expect(validate({ evidence: evidence({ claimedSuccess: true }), contract: typoFix }).passed).toBe(false);
  });

  it('demands a green check of a task that was judged to need proving', () => {
    const bugFix = contractFor({ verificationNeed: 0.8 });
    expect(validate({
      evidence: evidence({ claimedSuccess: true, artifactIds: ['src/a.ts'] }),
      contract: bugFix,
    }).passed).toBe(false);
    expect(validate({
      evidence: evidence({
        claimedSuccess: true, artifactIds: ['src/a.ts'],
        observedChecks: [{ id: 'c', command: 'npm test', passed: true }],
      }),
      contract: bugFix,
    }).passed).toBe(true);
  });

  it('never derives a floor nothing in this runtime could satisfy', () => {
    // `Add a unit test for X` scores 0.95. Demanding a fresh re-run for it
    // would make every task of that shape permanently unverifiable rather than
    // merely demanding.
    const demanding = contractFor({ verificationNeed: 0.95 });
    expect(demanding.qualityFloor).toBeLessThanOrEqual(MAXIMUM_DERIVED_FLOOR);
    expect(validate({
      evidence: evidence({
        claimedSuccess: true,
        observedChecks: [{ id: 'c', command: 'npm test', passed: true }],
      }),
      contract: demanding,
    }).passed).toBe(true);
  });

  it('honours an explicit floor exactly as written, however unsatisfiable', () => {
    // The bound is on the *derivation*, which is a guess. A person who writes
    // qualityFloor: 1 gets what they asked for, and that is what keeps the
    // floor falsifiable.
    expect(validate({
      evidence: evidence({
        claimedSuccess: true,
        observedChecks: [{ id: 'c', command: 'npm test', passed: true }],
      }),
      contract: { qualityFloor: 1, requiredChecks: [], allowedUncertainty: 0 },
      verify: greenVerifier,
    }).passed).toBe(false);
  });

  it('never derives a floor a bare claim could satisfy', () => {
    for (const need of [0, 0.1, 0.25, 0.5, 0.8, 1]) {
      const derived = contractFor({ verificationNeed: need });
      expect(derived.qualityFloor, String(need)).toBeGreaterThan(LEVEL_MODEL.V0.confidence);
    }
  });

  it('survives a nonsense verification need', () => {
    expect(contractFor({ verificationNeed: Number.NaN }).qualityFloor).toBeGreaterThan(0);
    expect(contractFor({ verificationNeed: -5 }).qualityFloor).toBe(MINIMUM_QUALITY_FLOOR);
  });
});
