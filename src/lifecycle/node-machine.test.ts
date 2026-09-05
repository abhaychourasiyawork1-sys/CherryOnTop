import { describe, it, expect, vi } from 'vitest';
import { createActor, fromPromise } from 'xstate';
import { nodeMachine } from './node-machine.js';

function machineWithMocks(overrides: {
  assessUncertainty?: { sufficientContext: boolean; complexity: 'low' | 'medium' | 'high' };
  executeStep?: { succeeded: boolean };
} = {}) {
  return nodeMachine.provide({
    actors: {
      assessUncertainty: fromPromise(async () => overrides.assessUncertainty ?? { sufficientContext: true, complexity: 'low' as const }),
      executeStep: fromPromise(async () => ({ message: 'ok', events: [], ...(overrides.executeStep ?? { succeeded: true }) })),
    },
  });
}

describe('nodeMachine', () => {
  it('starts in CREATED and auto-progresses through ORIENT/PLAN/INTELLIGENCE_GATE to EXECUTION_DECISION on START', async () => {
    const actor = createActor(machineWithMocks(), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    expect(actor.getSnapshot().value).toBe('CREATED');
    actor.send({ type: 'START' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('EXECUTION_DECISION'));
  });

  it('loops back to PLAN on insufficient context, but gives up after a bounded number of retries', async () => {
    const actor = createActor(machineWithMocks({ assessUncertainty: { sufficientContext: false, complexity: 'low' } }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    // PLAN -> INTELLIGENCE_GATE -> (insufficient) -> PLAN is a real loop, and with a
    // coordinator that never reports sufficiency it must terminate rather than spin.
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('EXECUTION_DECISION'));
    expect(actor.getSnapshot().context.gateAttempts).toBe(3);
  });

  it('carries complexity into context from the coordinator', async () => {
    const actor = createActor(machineWithMocks({ assessUncertainty: { sufficientContext: true, complexity: 'high' } }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('EXECUTION_DECISION'));
    expect(actor.getSnapshot().context.complexity).toBe('high');
  });

  it('reaches COMPLETE via SELF_EXECUTE -> VERIFY -> DOD_MET when execution succeeds', async () => {
    const actor = createActor(machineWithMocks({ executeStep: { succeeded: true } }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('EXECUTION_DECISION'));
    actor.send({ type: 'SELF_EXECUTE' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('VERIFY'));
    actor.send({ type: 'DOD_MET' });
    expect(actor.getSnapshot().value).toBe('COMPLETE');
  });

  it('re-plans when DoD is not met after verification', async () => {
    const actor = createActor(machineWithMocks(), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('EXECUTION_DECISION'));
    actor.send({ type: 'SELF_EXECUTE' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('VERIFY'));
    actor.send({ type: 'DOD_NOT_MET' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('EXECUTION_DECISION'));
  });
});
