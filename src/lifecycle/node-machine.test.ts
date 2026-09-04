import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import { nodeMachine } from './node-machine.js';

describe('nodeMachine', () => {
  it('starts in CREATED and moves through ORIENT/PLAN to INTELLIGENCE_GATE on START', () => {
    const actor = createActor(nodeMachine, { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    expect(actor.getSnapshot().value).toBe('CREATED');
    actor.send({ type: 'START' });
    expect(actor.getSnapshot().value).toBe('INTELLIGENCE_GATE');
  });

  it('loops back to PLAN when context is insufficient, then proceeds when sufficient', () => {
    const actor = createActor(nodeMachine, { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    actor.send({ type: 'CONTEXT_INSUFFICIENT' });
    expect(actor.getSnapshot().value).toBe('INTELLIGENCE_GATE');
    actor.send({ type: 'CONTEXT_SUFFICIENT' });
    expect(actor.getSnapshot().value).toBe('EXECUTION_DECISION');
  });

  it('reaches COMPLETE via SELF_EXECUTE -> VERIFY -> DOD_MET', () => {
    const actor = createActor(nodeMachine, { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    actor.send({ type: 'CONTEXT_SUFFICIENT' });
    actor.send({ type: 'SELF_EXECUTE' });
    expect(actor.getSnapshot().value).toBe('VERIFY');
    actor.send({ type: 'DOD_MET' });
    expect(actor.getSnapshot().value).toBe('COMPLETE');
    expect(actor.getSnapshot().status).toBe('done');
  });

  it('re-plans when DoD is not met after verification', () => {
    const actor = createActor(nodeMachine, { input: { nodeId: 'n1', goal: 'test' } });
    actor.start();
    actor.send({ type: 'START' });
    actor.send({ type: 'CONTEXT_SUFFICIENT' });
    actor.send({ type: 'SELF_EXECUTE' });
    actor.send({ type: 'DOD_NOT_MET' });
    expect(actor.getSnapshot().value).toBe('INTELLIGENCE_GATE');
  });
});
