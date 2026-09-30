import { describe, it, expect } from 'vitest';
import { reviewChildWork, type ChildRunResult } from './delegation-review.js';
import type { ValidationResult } from '../validation/engine.js';

const GREEN: ValidationResult = {
  level: 'V2', passed: true, confidence: 0.85, tokens: 0, latencyMs: 0,
  evidenceIds: ['observed:npm test'], reasonCodes: ['V2:observed_verification_passed'],
};
const RED: ValidationResult = { ...GREEN, passed: false, reasonCodes: ['V2:observed_verification_failed'] };

const assignment = (acceptanceChecks: string[] = []) => ({ id: 'a1', acceptanceChecks, dependencies: [] as string[] });

function run(over: Partial<ChildRunResult> = {}): ChildRunResult {
  return {
    succeeded: true, validation: GREEN, changedFiles: ['src/cart.ts'],
    observedChecks: [{ id: 'observed:npm test', command: 'npm test', passed: true }], ...over,
  };
}

describe('reviewChildWork', () => {
  it('accepts a child whose own validation passed when the parent asked for nothing extra', () => {
    const verdict = reviewChildWork({ assignment: assignment(), run: run() });
    expect(verdict.accepted).toBe(true);
    expect(verdict.failedChecks).toEqual([]);
  });

  it('accepts when every parent acceptance check has passing evidence, and cites it', () => {
    const verdict = reviewChildWork({ assignment: assignment(['npm test passes']), run: run() });
    expect(verdict.accepted).toBe(true);
    expect(verdict.evidenceRefs).toContain('observed:npm test');
  });

  it('evaluates the parent\'s checks in addition to the child\'s own validation', () => {
    // The child satisfied its own definition of done. The parent asked for more.
    const verdict = reviewChildWork({
      assignment: assignment(['tsc --noEmit is clean']),
      run: run(), // only ran npm test
    });
    expect(verdict.accepted).toBe(false);
    expect(verdict.failedChecks).toEqual([expect.objectContaining({
      check: 'tsc --noEmit is clean', observed: expect.stringContaining('no evidence'),
    })]);
  });

  it('never accepts a check for which there is no evidence at all', () => {
    const verdict = reviewChildWork({ assignment: assignment(['the checkout page renders']), run: run({ observedChecks: [] }) });
    expect(verdict.accepted).toBe(false);
    expect(verdict.failedChecks[0].check).toBe('the checkout page renders');
  });

  it('rejects a check whose only matching run failed, and points at that run', () => {
    const verdict = reviewChildWork({
      assignment: assignment(['npm test']),
      run: run({ observedChecks: [{ id: 'observed:npm test', command: 'npm test', passed: false }] }),
    });
    expect(verdict.accepted).toBe(false);
    expect(verdict.failedChecks[0]).toMatchObject({ check: 'npm test', observed: expect.stringContaining('failed'), evidenceRefs: ['observed:npm test'] });
  });

  it('rejects a child that claimed success its own validation could not back', () => {
    const verdict = reviewChildWork({ assignment: assignment(), run: run({ succeeded: true, validation: RED }) });
    expect(verdict.accepted).toBe(false);
    expect(verdict.failedChecks[0].check).toMatch(/own validation/);
  });

  it('rejects a child that did not finish', () => {
    const verdict = reviewChildWork({ assignment: assignment(), run: run({ succeeded: false, validation: RED }) });
    expect(verdict.accepted).toBe(false);
  });

  it('rejects green work that breached its authority', () => {
    const verdict = reviewChildWork({ assignment: assignment(), run: run({ authorityCompliant: false }) });
    expect(verdict.accepted).toBe(false);
    expect(verdict.failedChecks.map((c) => c.check).join(' ')).toMatch(/authority/);
  });

  it('lets an injected verifier supply fresh evidence for a check the trace cannot', () => {
    const verdict = reviewChildWork({
      assignment: assignment(['file:src/cart.ts']),
      run: run({ observedChecks: [] }),
      verifyCheck: (check) => (check === 'file:src/cart.ts' ? { passed: true, evidenceId: 'fs:src/cart.ts' } : null),
    });
    expect(verdict.accepted).toBe(true);
    expect(verdict.evidenceRefs).toContain('fs:src/cart.ts');
  });

  it('lets a failing verifier veto what the trace claimed', () => {
    const verdict = reviewChildWork({
      assignment: assignment(['npm test']),
      run: run(),
      verifyCheck: () => ({ passed: false, evidenceId: 'fresh:npm test', observed: 'red on the candidate tree' }),
    });
    expect(verdict.accepted).toBe(false);
    expect(verdict.failedChecks[0]).toMatchObject({ observed: 'red on the candidate tree', evidenceRefs: ['fresh:npm test'] });
  });

  it('accepts a read-only child on the strength of its own validated evidence', () => {
    // No files changed: an investigation's product is its report.
    const verdict = reviewChildWork({
      assignment: assignment(),
      run: run({ changedFiles: [], observedChecks: [], validation: { ...GREEN, level: 'V1', evidenceIds: ['artifact:result-1'] } }),
    });
    expect(verdict.accepted).toBe(true);
  });

  it('is total when the child left no validation record at all', () => {
    const passing = reviewChildWork({ assignment: assignment(), run: { succeeded: true } });
    const failing = reviewChildWork({ assignment: assignment(), run: { succeeded: false } });
    expect(passing.accepted).toBe(true);
    expect(failing.accepted).toBe(false);
  });
});
