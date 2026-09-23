import { describe, it, expect } from 'vitest';
import {
  actionCandidate, normalizeActionCandidate, ACTION_KINDS, isActionKind,
  type ActionCandidate,
} from './actions.js';

describe('the action contract is generic', () => {
  /** Five actions from five completely different parts of the runtime, built
   *  through one constructor with no task class anywhere in sight. This is the
   *  architectural claim the whole layer rests on: adding a capability must not
   *  mean adding a pathway. */
  const candidates: ActionCandidate[] = [
    actionCandidate({
      id: 'ctx-1', kind: 'acquire_evidence', capability: 'context.select',
      expectedTokenBenefit: 2400, tokenCost: 300, confidence: 0.8,
    }),
    actionCandidate({
      id: 'val-1', kind: 'validate', capability: 'validation.unit-tests',
      expectedQualityBenefit: 0.4, tokenCost: 900, latencyCost: 40_000, confidence: 0.9,
    }),
    actionCandidate({
      id: 'exp-1', kind: 'explore', capability: 'agent.search',
      expectedInformationGain: 0.5, tokenCost: 1200, confidence: 0.4,
    }),
    actionCandidate({
      id: 'rec-1', kind: 'recover', capability: 'recovery.retry',
      expectedProgress: 0.5, tokenCost: 4000, failureRisk: 0.4, confidence: 0.5,
    }),
    actionCandidate({
      id: 'par-1', kind: 'parallelize', capability: 'execution.workstreams',
      expectedLatencyBenefit: 120_000, coordinationCost: 800, tokenCost: 800, confidence: 0.6,
    }),
  ];

  it('constructs every action kind through the same interface', () => {
    expect(candidates.map((c) => c.kind)).toEqual([
      'acquire_evidence', 'validate', 'explore', 'recover', 'parallelize',
    ]);
  });

  it('requires no task category to construct an action', () => {
    for (const candidate of candidates) {
      expect(Object.keys(candidate)).not.toContain('taskClass');
      expect(Object.keys(candidate)).not.toContain('taskType');
      expect(Object.keys(candidate)).not.toContain('workflow');
    }
  });

  it('gives every action the same comparable economic dimensions', () => {
    const economic = [
      'expectedProgress', 'expectedInformationGain', 'expectedTokenBenefit',
      'expectedQualityBenefit', 'expectedLatencyBenefit', 'tokenCost', 'latencyCost',
      'qualityRisk', 'coordinationCost', 'failureRisk', 'orchestrationCost', 'confidence',
    ];
    for (const candidate of candidates) {
      for (const field of economic) {
        expect(Number.isFinite(candidate[field as keyof ActionCandidate] as number)).toBe(true);
      }
    }
  });

  it('carries capability-specific detail in metadata rather than in new fields', () => {
    const withDetail = actionCandidate({
      id: 'ctx-2', kind: 'acquire_evidence', capability: 'context.select',
      metadata: { candidateId: 'src/auth/session.ts', evidenceLevel: 'L2' },
    });
    expect(withDetail.metadata.evidenceLevel).toBe('L2');
    expect(Object.keys(withDetail).sort()).toEqual(Object.keys(candidates[0]).sort());
  });
});

describe('normalizeActionCandidate', () => {
  it('defaults every unspecified economic dimension to zero', () => {
    const c = actionCandidate({ id: 'a', kind: 'continue', capability: 'agent.continue' });
    expect(c.tokenCost).toBe(0);
    expect(c.expectedTokenBenefit).toBe(0);
    expect(c.orchestrationCost).toBe(0);
    expect(c.metadata).toEqual({});
  });

  it('replaces non-finite numbers with safe values rather than propagating NaN', () => {
    const c = normalizeActionCandidate({
      id: 'a', kind: 'explore', capability: 'agent.search',
      expectedTokenBenefit: Number.NaN, tokenCost: Number.POSITIVE_INFINITY,
      confidence: Number.NaN, qualityRisk: Number.NEGATIVE_INFINITY,
    } as ActionCandidate);
    expect(c.expectedTokenBenefit).toBe(0);
    expect(c.tokenCost).toBe(0);
    // An unreadable confidence is the cautious middle, not certainty.
    expect(c.confidence).toBe(0.5);
    expect(c.qualityRisk).toBe(0);
  });

  it('clamps the normalized fields into [0,1] and leaves unbounded ones alone', () => {
    const c = normalizeActionCandidate({
      id: 'a', kind: 'validate', capability: 'v',
      confidence: 7, qualityRisk: -3, failureRisk: 4,
      expectedProgress: 9, expectedInformationGain: -1, expectedQualityBenefit: 8,
      expectedTokenBenefit: 50_000, tokenCost: 12_345, latencyCost: 90_000,
    } as ActionCandidate);
    expect(c.confidence).toBe(1);
    expect(c.qualityRisk).toBe(0);
    expect(c.failureRisk).toBe(1);
    expect(c.expectedProgress).toBe(1);
    expect(c.expectedInformationGain).toBe(0);
    expect(c.expectedQualityBenefit).toBe(1);
    expect(c.expectedTokenBenefit).toBe(50_000);
    expect(c.tokenCost).toBe(12_345);
    expect(c.latencyCost).toBe(90_000);
  });

  it('refuses negative costs, which would read as benefits', () => {
    const c = normalizeActionCandidate({
      id: 'a', kind: 'explore', capability: 'x', tokenCost: -500, coordinationCost: -1, orchestrationCost: -2,
    } as ActionCandidate);
    expect(c.tokenCost).toBe(0);
    expect(c.coordinationCost).toBe(0);
    expect(c.orchestrationCost).toBe(0);
  });

  it('is idempotent', () => {
    const once = actionCandidate({ id: 'a', kind: 'stop', capability: 'runtime.stop', confidence: 0.3 });
    expect(normalizeActionCandidate(once)).toEqual(once);
  });

  it('falls back to `continue` for an unrecognised kind', () => {
    const c = normalizeActionCandidate({ id: 'a', kind: 'teleport', capability: 'x' } as unknown as ActionCandidate);
    expect(c.kind).toBe('continue');
  });
});

describe('ACTION_KINDS', () => {
  it('covers exactly the generic vocabulary', () => {
    expect([...ACTION_KINDS].sort()).toEqual([
      'acquire_evidence', 'constrain', 'continue', 'explore', 'parallelize',
      'recover', 'reuse_evidence', 'serialize', 'stop', 'validate',
    ]);
  });

  it('recognises its own members and nothing else', () => {
    expect(isActionKind('validate')).toBe(true);
    expect(isActionKind('refactor_typescript_file')).toBe(false);
  });
});
