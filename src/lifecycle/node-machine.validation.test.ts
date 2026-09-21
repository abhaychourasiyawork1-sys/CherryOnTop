/** The one thing the lifecycle must never do: call a finished run a successful
 *  task because it finished.
 *
 *  `EXECUTION_FINISHED` is a fact about a process. `TASK_SUCCESS` is a claim
 *  about the world. The primary metric is tokens per *successful* task, so a
 *  success count that includes runs which did not work scores an optimizer that
 *  makes runs cheaper and wronger as an improvement — which is why the only
 *  edge into COMPLETE goes through VALIDATE. */
import { describe, it, expect, vi } from 'vitest';
import { createActor, fromPromise, waitFor } from 'xstate';
import { nodeMachine } from './node-machine.js';
import { nextAfterValidation, type ValidationResult } from '../validation/engine.js';
import { ZERO_USAGE } from '../execution/tokens.js';
import type { ExecuteStepResult } from '../execution/execute-step.js';
import type { IntelligenceBundle } from '../intelligence/coordinator.js';
import type { DecideExecutionResult } from '../engines/decide-execution.js';

const PASSED: ValidationResult = {
  level: 'V2', passed: true, confidence: 0.85, tokens: 0, latencyMs: 0,
  evidenceIds: ['observed:npm test'], reasonCodes: ['V2:observed_verification_passed'],
};
const FAILED: ValidationResult = {
  level: 'V1', passed: false, confidence: 0.5, tokens: 0, latencyMs: 0,
  evidenceIds: ['artifact-1'], reasonCodes: ['below_required_confidence'],
};

describe('nextAfterValidation', () => {
  it('cannot transition to COMPLETE from execution success alone', () => {
    expect(nextAfterValidation({
      executionSucceeded: true, validation: FAILED, executionAttempts: 0,
    })).not.toBe('COMPLETE');
  });

  it('completes only when execution succeeded and validation passed', () => {
    expect(nextAfterValidation({
      executionSucceeded: true, validation: PASSED, executionAttempts: 0,
    })).toBe('COMPLETE');
  });

  it('refuses to complete a passing validation of a failed execution', () => {
    expect(nextAfterValidation({
      executionSucceeded: false, validation: PASSED, executionAttempts: 0,
    })).toBe('RECOVER');
  });

  it('recovers while attempts remain and fails once they run out', () => {
    expect(nextAfterValidation({ executionSucceeded: true, validation: FAILED, executionAttempts: 0 })).toBe('RECOVER');
    expect(nextAfterValidation({ executionSucceeded: true, validation: FAILED, executionAttempts: 3 })).toBe('FAILED');
  });

  it('does not retry a refusal that retrying cannot fix', () => {
    // A rate-limited dispatch does not become affordable a few minutes later,
    // and burning the remaining attempts on it was a measured cost.
    expect(nextAfterValidation({
      executionSucceeded: false, validation: FAILED, executionAttempts: 0, retriable: false,
    })).toBe('FAILED');
  });
});

function machine(overrides: {
  execution?: Partial<ExecuteStepResult>;
  validation?: ValidationResult | (() => Promise<ValidationResult>);
  onValidate?: () => void;
}) {
  return nodeMachine.provide({
    actors: {
      assessUncertainty: fromPromise(async (): Promise<IntelligenceBundle> => ({
        sufficientContext: true, complexity: 'low', worthSplitting: false, signals: {},
      })),
      decideExecution: fromPromise(async (): Promise<DecideExecutionResult> => ({ outcome: 'SELF_EXECUTE', breakdown: {} })),
      executeStep: fromPromise(async (): Promise<ExecuteStepResult> => ({
        succeeded: true, message: 'done', events: [], usage: { ...ZERO_USAGE }, ...(overrides.execution ?? {}),
      })),
      delegateToChild: fromPromise(async (): Promise<ExecuteStepResult> => ({
        succeeded: true, message: '', events: [], usage: { ...ZERO_USAGE },
      })),
      escalate: fromPromise(async () => 'approval-1'),
      validate: fromPromise(async (): Promise<ValidationResult> => {
        overrides.onValidate?.();
        return typeof overrides.validation === 'function'
          ? overrides.validation()
          : overrides.validation ?? PASSED;
      }),
    },
  });
}

async function run(overrides: Parameters<typeof machine>[0]) {
  const actor = createActor(machine(overrides), { input: { nodeId: 'n1', goal: 'g' } });
  actor.start();
  actor.send({ type: 'START' });
  return waitFor(actor, (snapshot) => snapshot.status === 'done', { timeout: 5000 });
}

describe('the lifecycle', () => {
  it('reaches COMPLETE only through VALIDATE', async () => {
    const validated = vi.fn();
    const snapshot = await run({ validation: PASSED, onValidate: validated });
    expect(snapshot.value).toBe('COMPLETE');
    expect(validated).toHaveBeenCalledTimes(1);
    expect(snapshot.context.lastValidation?.passed).toBe(true);
  });

  it('does not complete a run whose execution succeeded and whose validation failed', async () => {
    const snapshot = await run({ validation: FAILED });
    expect(snapshot.value).toBe('FAILED');
    expect(snapshot.context.lastValidation?.passed).toBe(false);
  });

  it('re-decides rather than completing, until the attempts run out', async () => {
    const validated = vi.fn();
    const snapshot = await run({ validation: FAILED, onValidate: validated });
    expect(snapshot.value).toBe('FAILED');
    // One attempt plus the bounded retries — never an unbounded loop.
    expect(validated.mock.calls.length).toBeGreaterThan(1);
    expect(validated.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('completes once a retry finally produces evidence', async () => {
    let attempt = 0;
    const snapshot = await run({
      validation: async () => (++attempt === 1 ? FAILED : PASSED),
    });
    expect(snapshot.value).toBe('COMPLETE');
    expect(attempt).toBe(2);
  });

  it('never manufactures a success when validation itself breaks', async () => {
    const snapshot = await run({ validation: async () => { throw new Error('evidence unreadable'); } });
    expect(snapshot.value).toBe('FAILED');
  });

  it('does not burn its attempts on a rate-limited refusal', async () => {
    const validated = vi.fn();
    const snapshot = await run({
      execution: { succeeded: false, rateLimited: true },
      validation: FAILED, onValidate: validated,
    });
    expect(snapshot.value).toBe('FAILED');
    expect(validated).toHaveBeenCalledTimes(1);
  });
});
