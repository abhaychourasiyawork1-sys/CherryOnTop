import { describe, it, expect } from 'vitest';
import {
  estimateStrategyPrior, observationFrom, outcomeKindOf, levelWeight, SHRINKAGE_K,
  type StrategyOutcomeObservation,
} from './hierarchical.js';
import { policyVersion } from '../efficiency/policy-version.js';

function observation(over: Partial<StrategyOutcomeObservation> = {}): StrategyOutcomeObservation {
  return {
    ...observationFrom({
      strategy: 'MANAGED', taskClass: 'implementation', taskShape: 'implementation/medium',
      validated: true, qualityDelta: 0, costUsd: 0.2, latencyMs: 60_000,
      recoveryCount: 0, validationLevel: 'V2',
    }),
    ...over,
  };
}

const good = () => observation({ success: true, qualityDelta: 0.1 });
const bad = () => observation({ success: false, qualityDelta: -0.2 });

describe('levelWeight', () => {
  it('gives a level with nothing to say no voice at all', () => {
    expect(levelWeight(0)).toBe(0);
  });

  it('gives one sample a small fraction of a voice', () => {
    expect(levelWeight(1)).toBeCloseTo(1 / (1 + SHRINKAGE_K));
    expect(levelWeight(1)).toBeLessThan(0.2);
  });

  it('gives a well-supported level most of the voice', () => {
    expect(levelWeight(SHRINKAGE_K)).toBeCloseTo(0.5);
    expect(levelWeight(100)).toBeGreaterThan(0.9);
  });
});

describe('estimateStrategyPrior', () => {
  it('produces a prior from global evidence alone', () => {
    const prior = estimateStrategyPrior({ global: [good(), good(), good()] });
    expect(prior.expectedSuccess).toBeGreaterThan(0.5);
    expect(prior.sourceLevels.map((key) => key.level)).toEqual(['GLOBAL']);
  });

  it('starts uninformed rather than optimistic when nothing is known', () => {
    const prior = estimateStrategyPrior({});
    expect(prior.expectedSuccess).toBe(0.5);
    expect(prior.effectiveObservations).toBe(0);
  });

  it('lets a well-supported task class move the global prior', () => {
    const globalEvidence = Array.from({ length: 20 }, bad);
    const classEvidence = Array.from({ length: 20 }, good);
    const withClass = estimateStrategyPrior({ global: globalEvidence, taskClass: classEvidence });
    const withoutClass = estimateStrategyPrior({ global: globalEvidence });
    expect(withClass.expectedSuccess).toBeGreaterThan(withoutClass.expectedSuccess);
  });

  it('does not let one exact-pattern sample overpower the broader history', () => {
    // The whole point of the shrinkage. Thirty runs say this fails; one run of
    // this exact shape says it worked. A policy that believes the one is a
    // policy that changes its mind every run.
    const prior = estimateStrategyPrior({
      global: Array.from({ length: 30 }, bad),
      exactPattern: [good()],
    });
    expect(prior.expectedSuccess).toBeLessThan(0.25);
  });

  it('lets repeated local evidence earn its weight', () => {
    const sparse = estimateStrategyPrior({
      global: Array.from({ length: 30 }, bad), exactPattern: [good()],
    });
    const dense = estimateStrategyPrior({
      global: Array.from({ length: 30 }, bad), exactPattern: Array.from({ length: 40 }, good),
    });
    expect(dense.expectedSuccess).toBeGreaterThan(sparse.expectedSuccess);
    expect(dense.expectedSuccess).toBeGreaterThan(0.6);
  });

  it('shrinks sparse exact evidence toward broader history', () => {
    const prior = estimateStrategyPrior({
      global: [good(), good()],
      taskClass: [good()],
      taskShape: [],
      exactPattern: [good()],
    });
    expect(prior.expectedSuccess).toBeGreaterThan(0.5);
    expect(prior.sourceLevels.at(-1)?.level).toBe('EXACT_PATTERN');
  });

  it('counts invalid observations and then excludes them', () => {
    const prior = estimateStrategyPrior({
      global: [good(), observation({ success: false, validity: 'INVALID_INFRA' })],
    });
    expect(prior.census.total).toBe(2);
    expect(prior.census.used).toBe(1);
    expect(prior.census.excluded.INVALID_INFRA).toBe(1);
  });

  it('excludes observations from an incomparable policy generation', () => {
    const version = policyVersion({ contextVersion: 'c1', executionVersion: 'e1' });
    const other = policyVersion({ contextVersion: 'c2', executionVersion: 'e2' });
    const prior = estimateStrategyPrior({
      policyVersion: version,
      global: [observation({ policyVersion: version }), observation({ policyVersion: other })],
    });
    expect(prior.census.excluded.INCOMPARABLE_POLICY).toBe(1);
  });

  it('keeps a prior about one strategy from being built out of another\'s runs', () => {
    const prior = estimateStrategyPrior({
      strategy: 'PARALLEL_DELEGATED',
      global: [good(), observation({ strategy: 'PARALLEL_DELEGATED', success: true })],
    });
    expect(prior.census.excluded.OTHER_STRATEGY).toBe(1);
    expect(prior.strategy).toBe('PARALLEL_DELEGATED');
  });

  it('reports success-after-recovery separately from clean success', () => {
    const prior = estimateStrategyPrior({
      global: [good(), observation({ success: true, recoveryCount: 2 }), bad()],
    });
    expect(prior.outcomes).toEqual({ SUCCESS: 1, SUCCESS_WITH_RECOVERY: 1, FAILURE: 1 });
  });
});

describe('observationFrom', () => {
  it('keys one run at every level it is evidence for', () => {
    const observed = observationFrom({
      strategy: 'SERIAL_DELEGATED', taskClass: 'multi_workstream', taskShape: 'multi/large',
      repository: 'github.com/acme/thing', exactPattern: 'fingerprint-1',
      validated: true, qualityDelta: 0.1, costUsd: 0.5, latencyMs: 90_000,
      recoveryCount: 0, validationLevel: 'V2',
    });
    expect(observed.task.map((key) => key.level)).toEqual([
      'GLOBAL', 'TASK_CLASS', 'TASK_SHAPE', 'REPOSITORY', 'EXACT_PATTERN',
    ]);
  });

  it('omits the levels a run has no key for', () => {
    expect(observationFrom({
      strategy: 'MANAGED', taskClass: 'trivial_edit', taskShape: 'trivial/tiny',
      validated: true, qualityDelta: 0, costUsd: 0.1, latencyMs: 30_000,
      recoveryCount: 0, validationLevel: 'V1',
    }).task.map((key) => key.level)).toEqual(['GLOBAL', 'TASK_CLASS', 'TASK_SHAPE']);
  });

  it('records an unvalidated run as a failure rather than a success', () => {
    expect(observationFrom({
      strategy: 'MANAGED', taskClass: 'implementation', taskShape: 's',
      validated: false, qualityDelta: 0, costUsd: 0.1, latencyMs: 1, recoveryCount: 0,
      validationLevel: 'V1',
    }).success).toBe(false);
  });
});

describe('outcomeKindOf', () => {
  it('distinguishes a clean success from one that needed recovery', () => {
    expect(outcomeKindOf({ success: true, recoveryCount: 0 })).toBe('SUCCESS');
    expect(outcomeKindOf({ success: true, recoveryCount: 1 })).toBe('SUCCESS_WITH_RECOVERY');
    expect(outcomeKindOf({ success: false, recoveryCount: 3 })).toBe('FAILURE');
  });
});
