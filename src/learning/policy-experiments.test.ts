import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../db/client.js';
import { policyVersion } from '../efficiency/policy-version.js';
import {
  draftCandidate, evaluateCandidate, summarizeEvidence, record, putCandidate,
  activePolicyChanges, MIN_VALID_OBSERVATIONS,
  observationFromStrategyRun, isTunableStrategyField,
  type ExperimentObservation, type PolicyCandidate,
} from './policy-experiments.js';

const TEST_DB = './test-policy-experiments.db';
const BASELINE = policyVersion();

afterEach(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const good = (over: Partial<ExperimentObservation> = {}): ExperimentObservation => ({
  validity: 'VALID', costDeltaUsd: -0.05, qualityDelta: 0.01,
  succeeded: true, policyVersion: BASELINE, ...over,
});

function candidate(over: Partial<PolicyCandidate> = {}): PolicyCandidate {
  return { ...draftCandidate({ name: 'narrower-context', changes: { contextBudget: 0.8 }, baseline: BASELINE }), ...over };
}

describe('drafting a candidate', () => {
  it('refuses to carry a field that is a safety constraint', () => {
    const drafted = draftCandidate({
      name: 'risky',
      changes: { contextBudget: 0.8, spendCapUsd: 10, 'authority.budget_usd': 5 },
      baseline: BASELINE,
    });
    expect(Object.keys(drafted.changes)).toEqual(['contextBudget']);
    expect(drafted.reason).toContain('spendCapUsd');
  });
});

describe('evidence', () => {
  it('counts invalid rows and then excludes them, rather than dropping them silently', () => {
    const subject = candidate({
      observations: [
        good(), good(),
        good({ validity: 'INVALID_TELEMETRY', costDeltaUsd: -2.0 }),
        good({ validity: 'INVALID_INFRA' }),
      ],
    });
    const evidence = summarizeEvidence(subject);
    expect(evidence.total).toBe(4);
    expect(evidence.valid).toBe(2);
    expect(evidence.excluded).toEqual({ INVALID_TELEMETRY: 1, INVALID_INFRA: 1 });
    // The $2.00 telemetry artifact — the real one from the September run — does
    // not get to define the cost model.
    expect(evidence.meanCostDeltaUsd).toBeCloseTo(-0.05);
  });

  it('excludes a run from a different policy generation', () => {
    const other = policyVersion({ executionVersion: 'exec-99' });
    const evidence = summarizeEvidence(candidate({ observations: [good(), good({ policyVersion: other })] }));
    expect(evidence.valid).toBe(1);
    expect(evidence.excluded.INCOMPARABLE_POLICY).toBe(1);
  });
});

describe('the promotion gate', () => {
  const many = (n: number, over: Partial<ExperimentObservation> = {}) =>
    Array.from({ length: n }, () => good(over));

  it('holds a candidate below the evidence floor', () => {
    const verdict = evaluateCandidate(candidate({ observations: many(MIN_VALID_OBSERVATIONS - 1) }));
    expect(verdict.status).toBe('SHADOW');
    expect(verdict.reason).toContain(`needs ${MIN_VALID_OBSERVATIONS}`);
  });

  it('will not promote cheaper-and-worse', () => {
    const verdict = evaluateCandidate(candidate({
      status: 'CANARY',
      observations: many(MIN_VALID_OBSERVATIONS, { costDeltaUsd: -0.5, qualityDelta: -0.05 }),
    }));
    expect(verdict.status).toBe('ROLLED_BACK');
    expect(verdict.reason).toContain('cheaper and worse');
  });

  it('walks draft to shadow to canary to promoted, never skipping a stage', () => {
    const observations = many(MIN_VALID_OBSERVATIONS);
    expect(evaluateCandidate(candidate({ status: 'DRAFT', observations })).status).toBe('SHADOW');
    expect(evaluateCandidate(candidate({ status: 'SHADOW', observations })).status).toBe('CANARY');
    expect(evaluateCandidate(candidate({ status: 'CANARY', observations })).status).toBe('PROMOTED');
  });

  it('keeps judging a promoted candidate against its rollback triggers', () => {
    const promoted = candidate({
      status: 'PROMOTED',
      observations: many(MIN_VALID_OBSERVATIONS, { qualityDelta: -0.5 }),
    });
    const verdict = evaluateCandidate(promoted);
    expect(verdict.status).toBe('ROLLED_BACK');
    expect(verdict.reason).toContain('quality fell');
  });

  it('withdraws a promoted candidate that quietly got more expensive', () => {
    const verdict = evaluateCandidate(candidate({
      status: 'PROMOTED',
      observations: many(MIN_VALID_OBSERVATIONS, { costDeltaUsd: 0.2, qualityDelta: 0.01 }),
    }));
    expect(verdict.status).toBe('ROLLED_BACK');
    expect(verdict.reason).toContain('cost rose');
  });
});

describe('recording against the store', () => {
  it('advances on evidence and nothing else, and only a promoted candidate changes policy', () => {
    const db = createDb(TEST_DB);
    const subject = candidate();
    putCandidate(db, subject);
    expect(activePolicyChanges(db)).toEqual({});

    let latest = null;
    // Enough to walk every stage: shadow, then canary, then promoted.
    for (let i = 0; i < MIN_VALID_OBSERVATIONS + 2; i++) latest = record(db, subject.id, good());
    expect(latest?.status).toBe('PROMOTED');
    expect(latest?.promotedAt).toBeTruthy();
    expect(activePolicyChanges(db)).toEqual({ contextBudget: 0.8 });

    // And it comes back out again the moment the evidence turns.
    for (let i = 0; i < 40; i++) latest = record(db, subject.id, good({ qualityDelta: -0.9 }));
    expect(latest?.status).toBe('ROLLED_BACK');
    expect(activePolicyChanges(db)).toEqual({});
  });

  it('cannot be promoted by invalid rows however many there are', () => {
    const db = createDb(TEST_DB);
    const subject = candidate();
    putCandidate(db, subject);
    let latest = null;
    for (let i = 0; i < 50; i++) {
      latest = record(db, subject.id, good({ validity: 'INVALID_INFRA', costDeltaUsd: -5 }));
    }
    expect(latest?.status).toBe('SHADOW');
    expect(activePolicyChanges(db)).toEqual({});
  });
});

describe('strategy candidates go through the same gate as any other', () => {
  const baseline = policyVersion({ contextVersion: 'c1', executionVersion: 'e1' });

  function strategyCandidate(over: Partial<PolicyCandidate> = {}): PolicyCandidate {
    return {
      ...draftCandidate({
        name: 'prefer-serial-delegation',
        changes: { 'strategy.delegationValue': 0.9, 'strategy.parallelPreference': 0.2 },
        baseline,
      }),
      status: 'CANARY',
      ...over,
    };
  }

  function evidence(count: number, arm: Partial<Parameters<typeof observationFromStrategyRun>[0]['candidate']> = {}) {
    return Array.from({ length: count }, () => observationFromStrategyRun({
      candidate: { validated: true, costUsd: 0.1, quality: 0.8, ...arm },
      baseline: { validated: true, costUsd: 0.2, quality: 0.8 },
      validity: 'VALID', policyVersion: baseline,
    }));
  }

  it('counts a run as a success only when it was validated', () => {
    // A delegated run that finished, proved nothing, and reported success is
    // evidence about a process — not about a strategy.
    const unvalidated = observationFromStrategyRun({
      candidate: { validated: false, costUsd: 0.1, quality: 0.8 },
      baseline: { validated: true, costUsd: 0.2, quality: 0.8 },
      validity: 'VALID', policyVersion: baseline,
    });
    expect(unvalidated.succeeded).toBe(false);
  });

  it('does not promote a strategy whose runs finished without validating', () => {
    const verdict = evaluateCandidate(strategyCandidate({
      observations: evidence(10, { validated: false }),
    }));
    expect(verdict.status).toBe('ROLLED_BACK');
    expect(verdict.evidence.successRate).toBe(0);
  });

  it('promotes a strategy that is cheaper at no quality cost, after canary', () => {
    const verdict = evaluateCandidate(strategyCandidate({ observations: evidence(10) }));
    expect(verdict.status).toBe('PROMOTED');
  });

  it('does not promote a cheaper strategy with worse verified quality', () => {
    const verdict = evaluateCandidate(strategyCandidate({
      observations: evidence(10, { quality: 0.6 }),
    }));
    expect(verdict.status).toBe('ROLLED_BACK');
    expect(verdict.reason).toContain('cheaper and worse');
  });

  it('rolls a promoted strategy back when it gets more expensive', () => {
    const verdict = evaluateCandidate(strategyCandidate({
      status: 'PROMOTED', observations: evidence(10, { costUsd: 0.4 }),
    }));
    expect(verdict.status).toBe('ROLLED_BACK');
    expect(verdict.reason).toContain('cost rose');
  });

  it('rolls a promoted strategy back when its success rate falls', () => {
    const verdict = evaluateCandidate(strategyCandidate({
      status: 'PROMOTED',
      observations: [...evidence(5), ...evidence(5, { validated: false })],
    }));
    expect(verdict.status).toBe('ROLLED_BACK');
    expect(verdict.reason).toContain('success rate');
  });

  it('still strips safety fields from a strategy candidate', () => {
    const candidate = draftCandidate({
      name: 'unsafe', baseline,
      changes: {
        'strategy.delegationValue': 0.9,
        'authority.budget_usd': 99,
        allowedTools: 1,
        spendCapUsd: 0,
      },
    });
    expect(Object.keys(candidate.changes)).toEqual(['strategy.delegationValue']);
    expect(candidate.reason).toContain('refused unlearnable fields');
  });

  it('refuses to treat capability availability as a tunable strategy field', () => {
    // A candidate that could set the agent allowance to zero would make
    // delegation unreachable — and "the benchmark stopped delegating" would
    // then read as evidence that delegation was not needed.
    expect(isTunableStrategyField('strategy.delegationValue')).toBe(true);
    expect(isTunableStrategyField('authority.max_child_count')).toBe(false);
    expect(isTunableStrategyField('max_child_count')).toBe(false);
    expect(isTunableStrategyField('sandbox.isolation')).toBe(false);
  });

  it('leaves the deterministic baseline active when nothing is promoted', () => {
    const db = createDb(TEST_DB);
    putCandidate(db, strategyCandidate({ status: 'CANARY' }));
    expect(activePolicyChanges(db)).toEqual({});
  });
});
