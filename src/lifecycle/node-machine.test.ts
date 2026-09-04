import { describe, it, expect, vi } from 'vitest';
import { createActor, fromPromise } from 'xstate';
import { nodeMachine } from './node-machine.js';

function machineWithMockExecute(result: { succeeded: boolean }) {
  return nodeMachine.provide({
    actors: {
      executeStep: fromPromise(async () => ({ message: 'mock', events: [], ...result })),
    },
  });
}

describe('nodeMachine', () => {
  it('starts in CREATED and moves through ORIENT/PLAN to INTELLIGENCE_GATE on START', () => {
    const actor = createActor(machineWithMockExecute({ succeeded: true }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    expect(actor.getSnapshot().value).toBe('CREATED');
    actor.send({ type: 'START' });
    expect(actor.getSnapshot().value).toBe('INTELLIGENCE_GATE');
  });

  it('loops back to PLAN when context is insufficient, then proceeds when sufficient', () => {
    const actor = createActor(machineWithMockExecute({ succeeded: true }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    actor.send({ type: 'CONTEXT_INSUFFICIENT' });
    expect(actor.getSnapshot().value).toBe('INTELLIGENCE_GATE');
    actor.send({ type: 'CONTEXT_SUFFICIENT' });
    expect(actor.getSnapshot().value).toBe('EXECUTION_DECISION');
  });

  it('reaches COMPLETE via SELF_EXECUTE -> VERIFY -> DOD_MET when execution succeeds', async () => {
    const actor = createActor(machineWithMockExecute({ succeeded: true }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    actor.send({ type: 'CONTEXT_SUFFICIENT' });
    actor.send({ type: 'SELF_EXECUTE' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('VERIFY'));
    actor.send({ type: 'DOD_MET' });
    expect(actor.getSnapshot().value).toBe('COMPLETE');
    expect(actor.getSnapshot().status).toBe('done');
  });

  it('re-plans when DoD is not met after verification', async () => {
    const actor = createActor(machineWithMockExecute({ succeeded: true }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    actor.send({ type: 'CONTEXT_SUFFICIENT' });
    actor.send({ type: 'SELF_EXECUTE' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('VERIFY'));
    actor.send({ type: 'DOD_NOT_MET' });
    expect(actor.getSnapshot().value).toBe('INTELLIGENCE_GATE');
  });

  it('carries the execution result into context on SELF_EXECUTE completion', async () => {
    const actor = createActor(machineWithMockExecute({ succeeded: false }), { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    actor.send({ type: 'CONTEXT_SUFFICIENT' });
    actor.send({ type: 'SELF_EXECUTE' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('VERIFY'));
    expect(actor.getSnapshot().context.lastResult?.succeeded).toBe(false);
  });

  it('still reaches VERIFY with a failed result when the execute actor throws', async () => {
    const machine = nodeMachine.provide({
      actors: { executeStep: fromPromise(async () => { throw new Error('cluster unreachable'); }) },
    });
    const actor = createActor(machine, { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    actor.send({ type: 'CONTEXT_SUFFICIENT' });
    actor.send({ type: 'SELF_EXECUTE' });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe('VERIFY'));
    expect(actor.getSnapshot().context.lastResult?.succeeded).toBe(false);
    expect(actor.getSnapshot().context.lastResult?.message).toContain('cluster unreachable');
  });
});
