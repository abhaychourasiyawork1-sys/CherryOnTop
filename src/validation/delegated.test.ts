import { describe, it, expect } from 'vitest';
import { validateDelegatedOutcome, type DelegatedChildOutcome, type DelegatedValidationInput } from './delegated.js';
import type { ValidationResult } from './engine.js';
import type { WorkstreamNode } from '../execution/workstreams.js';

const PASSED: ValidationResult = {
  level: 'V2', passed: true, confidence: 0.85, tokens: 0, latencyMs: 0,
  evidenceIds: ['observed:npm test'], reasonCodes: ['V2:observed_verification_passed'],
};
const FAILED: ValidationResult = {
  ...PASSED, passed: false, confidence: 0.85, reasonCodes: ['V2:observed_verification_failed'],
};

function child(id: string, over: Partial<DelegatedChildOutcome> = {}): DelegatedChildOutcome {
  return {
    id, succeeded: true, validation: PASSED, changedPaths: [`src/${id}.ts`],
    authorityCompliant: true, dependenciesSatisfied: true, ...over,
  };
}

function node(id: string, inputDependencies: string[] = []): WorkstreamNode {
  return {
    id, inputDependencies, informationDependencies: [],
    outputDependencies: [], validationDependencies: [], writePaths: [`src/${id}.ts`],
  };
}

function aggregate(over: Partial<DelegatedValidationInput> = {}) {
  return validateDelegatedOutcome({
    parentRequiredChecks: [],
    children: [child('a'), child('b')],
    mergedOutcome: {
      claimedSuccess: true, artifactIds: ['artifact-1'],
      observedChecks: [{ id: 'observed:npm test', command: 'npm test', passed: true }],
      requiredChecks: [],
    },
    ...over,
  });
}

describe('validateDelegatedOutcome', () => {
  it('passes when every child validated inside its authority', () => {
    const result = aggregate();
    expect(result.passed).toBe(true);
    expect(result.childFailures).toEqual([]);
    expect(result.retainedChildren).toEqual(['a', 'b']);
  });

  it('rejects when a child required for the parent outcome failed', () => {
    const result = aggregate({ children: [child('a'), child('b', { succeeded: false, validation: FAILED })] });
    expect(result.passed).toBe(false);
    expect(result.childFailures).toEqual(['b']);
    expect(result.reasons).toContain('required_child_failed');
  });

  it('rejects a child that reported success and could not back it', () => {
    const result = aggregate({ children: [child('a'), child('b', { succeeded: true, validation: FAILED })] });
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('child_validation_failed:b');
  });

  it('rejects a green child that stepped outside its authority', () => {
    const result = aggregate({ children: [child('a'), child('b', { authorityCompliant: false })] });
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('authority_violation:b');
  });

  it('rejects a child that ran before its prerequisite finished', () => {
    const result = aggregate({ children: [child('a'), child('b', { dependenciesSatisfied: false })] });
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('ran_before_prerequisite:b');
  });

  it('keeps independent successful siblings when another child fails', () => {
    const result = aggregate({
      children: [child('a'), child('b', { succeeded: false, validation: FAILED }), child('c')],
      graph: [node('a'), node('b'), node('c')],
    });
    expect(result.retainedChildren).toEqual(['a', 'c']);
    expect(result.blockedDependents).toEqual([]);
    expect(result.reasons).toContain('retained_siblings:2');
  });

  it('names only the dependents of the failed child as blocked', () => {
    const result = aggregate({
      children: [child('a', { succeeded: false, validation: FAILED }), child('b'), child('c')],
      // b consumes a's output; c is unrelated.
      graph: [node('a'), node('b', ['a']), node('c')],
    });
    expect(result.blockedDependents).toEqual(['b']);
    expect(result.retainedChildren).toEqual(['c']);
  });

  it('does not fail the parent for an optional child', () => {
    const result = aggregate({
      children: [child('a'), child('b', { succeeded: false, validation: FAILED, required: false })],
      graph: [node('a'), node('b')],
    });
    expect(result.childFailures).toEqual(['b']);
    expect(result.reasons).not.toContain('required_child_failed');
    expect(result.passed).toBe(true);
  });

  it('rejects when the parent\'s own merged evidence cannot clear the ladder', () => {
    const result = aggregate({
      mergedOutcome: { claimedSuccess: true, artifactIds: [], observedChecks: [], requiredChecks: [] },
    });
    expect(result.passed).toBe(false);
    expect(result.parentValidation.passed).toBe(false);
  });

  it('rejects when a check a person named for the parent is still open', () => {
    const result = aggregate({
      parentRequiredChecks: ['changelog updated'],
      mergedOutcome: {
        claimedSuccess: true, artifactIds: ['artifact-1'],
        observedChecks: [{ id: 'observed:npm test', command: 'npm test', passed: true }],
        requiredChecks: [{ id: 'dod-1', text: 'changelog updated', met: false }],
      },
    });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.startsWith('parent_required_checks_unmet'))).toBe(true);
  });

  it('refuses to call a fan-out with no children a validated outcome', () => {
    const result = aggregate({ children: [] });
    expect(result.passed).toBe(false);
    expect(result.reasons).toContain('no_children_to_aggregate');
  });
});
