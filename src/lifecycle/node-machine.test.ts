import { describe, it, expect, vi } from 'vitest';
import { createActor, fromPromise } from 'xstate';
import { nodeMachine } from './node-machine.js';

function machineWithMocks(overrides: {
  assessUncertainty?: { sufficientContext: boolean; complexity: 'low' | 'medium' | 'high' };
  decideExecution?: { outcome: 'SELF_EXECUTE' | 'DELEGATE' | 'ESCALATE'; breakdown: Record<string, number> };
  executeStep?: { succeeded: boolean };
} = {}) {
  return nodeMachine.provide({
    actors: {
      assessUncertainty: fromPromise(async () => overrides.assessUncertainty ?? { sufficientContext: true, complexity: 'low' as const }),
      decideExecution: fromPromise(async () => overrides.decideExecution ?? { outcome: 'SELF_EXECUTE' as const, breakdown: {} }),
      executeStep: fromPromise(async () => ({ message: 'ok', events: [], ...(overrides.executeStep ?? { succeeded: true }) })),
      delegateToChild: fromPromise(async () => ({ succeeded: true, message: 'ok', events: [] })),
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

  it('transitions to ESCALATE when the decision combinator says so', async () => {
    const actor = createActor(machineWithMocks({ decideExecution: { outcome: 'ESCALATE', breakdown: { requiredBudget: 1, availableBudget: 0.01 } } }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('ESCALATE'));
  });

  it('transitions to DELEGATE, awaits the child, and completes on its result', async () => {
    const actor = createActor(machineWithMocks({ decideExecution: { outcome: 'DELEGATE', breakdown: {} } }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('COMPLETE'));
  });
});
