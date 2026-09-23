/** Retry and recovery are different things, and this is where they stay
 *  different.
 *
 *  A retry re-runs the attempt. A recovery changes something about it. The
 *  expensive mistake is calling the first the second: three full sandboxes into
 *  one identical refusal, each paying what the first paid, for a worse chance. */
import { describe, it, expect } from 'vitest';
import { strategyRetryAllowed, evaluateRecovery, tombstoneFor } from './engine.js';
import { novelState } from '../architecture/fixtures.js';

const base = {
  currentStrategy: 'MANAGED',
  previousStrategies: ['MANAGED'],
  failureSignature: 'test_x_failed',
  previousFailureSignatures: ['test_x_failed'],
  progress: 0,
};

describe('strategyRetryAllowed', () => {
  it('does not retry the same strategy after the same failure', () => {
    expect(strategyRetryAllowed(base)).toBe(false);
  });

  it('allows a different strategy after an identical failure', () => {
    expect(strategyRetryAllowed({ ...base, currentStrategy: 'SERIAL_DELEGATED' })).toBe(true);
  });

  it('allows the same strategy after a different failure', () => {
    // A run working through three distinct problems is making progress, and
    // counting those against it stops exactly the run that was going to succeed.
    expect(strategyRetryAllowed({ ...base, failureSignature: 'build_failed' })).toBe(true);
  });

  it('allows the same strategy again when the failed attempt got somewhere', () => {
    expect(strategyRetryAllowed({ ...base, progress: 0.6 })).toBe(true);
  });

  it('allows a first attempt, which has nothing to repeat', () => {
    expect(strategyRetryAllowed({
      ...base, previousStrategies: [], previousFailureSignatures: [],
    })).toBe(true);
  });
});

describe('recovery economics around the strategy rule', () => {
  const spent = novelState({
    over: {
      evidence: [{ id: 'observed:src/a.ts', kind: 'fact', source: 'read', confidence: 0.9, tokenCost: 4_000 }],
      resources: {
        totalTokenBudget: 100_000, consumedTokens: 70_000, remainingTokens: 30_000,
        optimizationTokens: 2_000, optimizationConsumedTokens: 0, recoveryReserve: 5_000,
      },
      trajectory: {
        progress: 0.7, informationGain: 0.5, explorationPressure: 0.3,
        failurePressure: 0.4, stateSimilarity: 0.3, orchestrationConfidence: 0.8,
      },
    },
  });

  it('keeps recovery reachable after a validation failure', () => {
    const evaluation = evaluateRecovery({ state: spent, failureSignature: 'validation_failed' });
    expect(evaluation.justified).toBe(true);
    expect(evaluation.retainedEvidenceIds).toContain('observed:src/a.ts');
  });

  it('gets less optimistic each time the same wall is hit', () => {
    const first = evaluateRecovery({ state: spent, failureSignature: 'validation_failed' });
    const tombstone = tombstoneFor({
      id: 't1', evaluation: first, failureSignature: 'validation_failed', tokensSpent: 10_000,
    });
    const second = evaluateRecovery({
      state: spent, failureSignature: 'validation_failed', tombstones: [tombstone],
    });
    expect(second.expectedSuccessProbability).toBeLessThan(first.expectedSuccessProbability);
    expect(second.reasonCodes).toContain('repeat_failure:1');
  });

  it('is untouched by an attempt that died a different way', () => {
    const first = evaluateRecovery({ state: spent, failureSignature: 'build_failed' });
    const tombstone = tombstoneFor({
      id: 't1', evaluation: first, failureSignature: 'build_failed', tokensSpent: 10_000,
    });
    const other = evaluateRecovery({
      state: spent, failureSignature: 'validation_failed', tombstones: [tombstone],
    });
    expect(other.expectedSuccessProbability).toBeCloseTo(first.expectedSuccessProbability);
  });

  it('stops entirely under a hard stop, whatever the strategy rule says', () => {
    const stopped = novelState({ over: { ...spent, constraints: { qualityFloor: 0.7, hardStop: true } } });
    expect(evaluateRecovery({ state: stopped, failureSignature: 'x' }).justified).toBe(false);
  });

  it('keeps a failed hypothesis dead across attempts', () => {
    const first = evaluateRecovery({
      state: spent, failureSignature: 'validation_failed', hypothesisIds: ['observed:src/a.ts'],
    });
    const tombstone = tombstoneFor({
      id: 't1', evaluation: first, failureSignature: 'validation_failed',
      tokensSpent: 10_000, hypothesisIds: ['observed:src/a.ts'],
    });
    const second = evaluateRecovery({
      state: spent, failureSignature: 'validation_failed', tombstones: [tombstone],
    });
    expect(second.retainedEvidenceIds).not.toContain('observed:src/a.ts');
  });
});
