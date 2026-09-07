import { describe, it, expect, vi } from 'vitest';
import { createActor, fromPromise, waitFor } from 'xstate';
import { nodeMachine } from './node-machine.js';
import type { ExecuteStepResult } from '../execution/execute-step.js';
import type { IntelligenceBundle } from '../intelligence/coordinator.js';
import type { DecideExecutionResult } from '../engines/decide-execution.js';

function machineWithMocks(overrides: {
  assessUncertainty?: Partial<IntelligenceBundle> & { sufficientContext: boolean; complexity: 'low' | 'medium' | 'high' };
  decideExecution?: { outcome: 'SELF_EXECUTE' | 'DELEGATE' | 'ESCALATE'; breakdown: Record<string, number> };
  executeStep?: { succeeded: boolean };
} = {}) {
  return nodeMachine.provide({
    actors: {
      assessUncertainty: fromPromise(async (): Promise<IntelligenceBundle> => ({
        worthSplitting: true, signals: {},
        ...(overrides.assessUncertainty ?? { sufficientContext: true, complexity: 'low' as const }),
      })),
      decideExecution: fromPromise(async () => overrides.decideExecution ?? { outcome: 'SELF_EXECUTE' as const, breakdown: {} }),
      executeStep: fromPromise(async (): Promise<ExecuteStepResult> => ({ message: 'ok', events: [], ...(overrides.executeStep ?? { succeeded: true }) })),
      delegateToChild: fromPromise(async (): Promise<ExecuteStepResult> => ({ succeeded: true, message: 'ok', events: [] })),
      escalate: fromPromise(async () => 'approval-1'),
    },
  });
}

describe('nodeMachine', () => {
  it('auto-progresses from CREATED through the whole loop to COMPLETE on START alone', async () => {
    const actor = createActor(machineWithMocks(), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    expect(actor.getSnapshot().value).toBe('CREATED');
    actor.send({ type: 'START' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('COMPLETE'));
  });

  it('loops back to PLAN on insufficient context, but gives up after a bounded number of retries', async () => {
    const actor = createActor(machineWithMocks({ assessUncertainty: { sufficientContext: false, complexity: 'low' } }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    // PLAN -> INTELLIGENCE_GATE -> (insufficient) -> PLAN is a real loop, and with a
    // coordinator that never reports sufficiency it must terminate rather than spin.
    await vi.waitFor(() => expect(actor.getSnapshot().status).toBe('done'));
    expect(actor.getSnapshot().context.gateAttempts).toBe(3);
  });

  it('carries complexity into context from the coordinator', async () => {
    const actor = createActor(machineWithMocks({ assessUncertainty: { sufficientContext: true, complexity: 'high' } }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('COMPLETE'));
    expect(actor.getSnapshot().context.complexity).toBe('high');
  });

  it('records the decision breakdown in context', async () => {
    const actor = createActor(machineWithMocks({ decideExecution: { outcome: 'SELF_EXECUTE', breakdown: { score: 0.42 } } }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('COMPLETE'));
    expect(actor.getSnapshot().context.lastDecision?.breakdown.score).toBe(0.42);
  });

  it('retries execution when the step fails, then lands in FAILED at the retry cap', async () => {
    const actor = createActor(machineWithMocks({ executeStep: { succeeded: false } }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('FAILED'));
    expect(actor.getSnapshot().context.executionAttempts).toBe(3);
  });

  it('escalates through to WAIT_APPROVAL when the decision combinator says so', async () => {
    const actor = createActor(machineWithMocks({ decideExecution: { outcome: 'ESCALATE', breakdown: { requiredBudget: 1, availableBudget: 0.01 } } }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('WAIT_APPROVAL'));
  });

  it('APPROVED resumes the blocked delegation through to COMPLETE', async () => {
    const actor = createActor(machineWithMocks({ decideExecution: { outcome: 'ESCALATE', breakdown: {} } }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('WAIT_APPROVAL'));
    actor.send({ type: 'APPROVED' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('COMPLETE'));
  });

  it('REJECTED sends the node to FAILED', async () => {
    const actor = createActor(machineWithMocks({ decideExecution: { outcome: 'ESCALATE', breakdown: {} } }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('WAIT_APPROVAL'));
    actor.send({ type: 'REJECTED' });
    expect(actor.getSnapshot().value).toBe('FAILED');
    expect(actor.getSnapshot().status).toBe('done');
  });

  it('transitions to DELEGATE, awaits the child, and completes on its result', async () => {
    const actor = createActor(machineWithMocks({ decideExecution: { outcome: 'DELEGATE', breakdown: {} } }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('COMPLETE'));
  });

  it('cancels mid-flight into a final CANCELLED state', async () => {
    const actor = createActor(machineWithMocks(), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    // The mocked actors resolve asynchronously, so this lands while the node is
    // still working somewhere past CREATED — the realistic cancel case.
    actor.send({ type: 'CANCEL' });
    expect(actor.getSnapshot().value).toBe('CANCELLED');
    expect(actor.getSnapshot().status).toBe('done');
  });

  it('cancels a node parked in WAIT_APPROVAL', async () => {
    // A node blocked on a human is the single most likely thing to be cancelled.
    const actor = createActor(machineWithMocks({ decideExecution: { outcome: 'ESCALATE', breakdown: {} } }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('WAIT_APPROVAL'));
    actor.send({ type: 'CANCEL' });
    expect(actor.getSnapshot().value).toBe('CANCELLED');
    expect(actor.getSnapshot().status).toBe('done');
  });

  it('cancels a node that has already reached COMPLETE without disturbing it', async () => {
    // Final states ignore events; cancelling a finished node must be a no-op
    // rather than resurrecting it into CANCELLED and rewriting history.
    const actor = createActor(machineWithMocks(), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('COMPLETE'));
    actor.send({ type: 'CANCEL' });
    expect(actor.getSnapshot().value).toBe('COMPLETE');
  });

  it('does the work itself when the goal turns out not to be delegatable', async () => {
    // Not a failure to retry: re-deciding reaches the same answer and pays for
    // another planning run each time.
    const executed: string[] = [];
    const machine = nodeMachine.provide({
      actors: {
        assessUncertainty: fromPromise(async (): Promise<IntelligenceBundle> => ({ sufficientContext: true, complexity: 'high', worthSplitting: true, signals: {} })),
        decideExecution: fromPromise(async (): Promise<DecideExecutionResult> => ({ outcome: 'DELEGATE', breakdown: {} })),
        delegateToChild: fromPromise(async (): Promise<ExecuteStepResult> => ({
          succeeded: false, notDelegatable: true, message: 'did not split', events: [],
        })),
        executeStep: fromPromise(async (): Promise<ExecuteStepResult> => {
          executed.push('self');
          return { succeeded: true, message: 'ok', events: [] };
        }),
        escalate: fromPromise(async () => 'approval-1'),
      },
    });

    const actor = createActor(machine, { input: { nodeId: 'n1', goal: 'g' } });
    actor.start();
    actor.send({ type: 'START' });
    const snapshot = await waitFor(actor, (s) => s.status === 'done', { timeout: 5000 });

    expect(snapshot.value).toBe('COMPLETE');
    // Exactly once — not once per retry.
    expect(executed).toEqual(['self']);
  });
});
