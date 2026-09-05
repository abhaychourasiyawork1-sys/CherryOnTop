import { setup, fromPromise, assign } from 'xstate';
import type { ExecuteStepResult } from '../execution/execute-step.js';

export interface NodeMachineContext {
  nodeId: string;
  goal: string;
  lastResult?: ExecuteStepResult;
}

export type NodeMachineEvent =
  | { type: 'START' }
  | { type: 'CONTEXT_SUFFICIENT' }
  | { type: 'CONTEXT_INSUFFICIENT' }
  | { type: 'SELF_EXECUTE' }
  | { type: 'DELEGATE' }
  | { type: 'DOD_MET' }
  | { type: 'DOD_NOT_MET' };

// Phase 1 skeleton with SELF_EXECUTE now backed by a real invoked actor.
// ORIENT/PLAN/DELEGATE still pass straight through and the caller drives the
// decision events; Phase 3 replaces those with economics/intelligence actors
// without changing these state names.
export const nodeMachine = setup({
  types: {
    context: {} as NodeMachineContext,
    events: {} as NodeMachineEvent,
    input: {} as NodeMachineContext,
  },
  actors: {
    // Placeholder — production wiring (node-actor-manager.ts) `.provide()`s the
    // real execute-step-backed actor; tests `.provide()` a mock. This default
    // exists only so the machine type-checks and can be inspected in isolation.
    executeStep: fromPromise<ExecuteStepResult, { nodeId: string; goal: string }>(async () => {
      throw new Error('executeStep actor not provided — call nodeMachine.provide({ actors: { executeStep: ... } })');
    }),
  },
}).createMachine({
  id: 'accountableNode',
  context: ({ input }) => input,
  initial: 'CREATED',
  states: {
    CREATED: { on: { START: 'ORIENT' } },
    ORIENT: { always: 'PLAN' },
    PLAN: { always: 'INTELLIGENCE_GATE' },
    INTELLIGENCE_GATE: {
      on: {
        CONTEXT_SUFFICIENT: 'EXECUTION_DECISION',
        CONTEXT_INSUFFICIENT: 'PLAN',
      },
    },
    EXECUTION_DECISION: {
      on: {
        SELF_EXECUTE: 'SELF_EXECUTE',
        DELEGATE: 'DELEGATE',
      },
    },
    SELF_EXECUTE: {
      invoke: {
        src: 'executeStep',
        input: ({ context }) => ({ nodeId: context.nodeId, goal: context.goal }),
        onDone: {
          target: 'VERIFY',
          actions: assign({ lastResult: ({ event }) => event.output }),
        },
        // A dispatch failure is a verifiable outcome, not a crash: VERIFY gets a
        // failed result and DOD_NOT_MET can re-plan around it.
        onError: {
          target: 'VERIFY',
          actions: assign({
            lastResult: ({ event }) => ({ succeeded: false, message: String(event.error), events: [] }),
          }),
        },
      },
    },
    DELEGATE: { always: 'VERIFY' },
    VERIFY: {
      on: {
        DOD_MET: 'COMPLETE',
        DOD_NOT_MET: 'INTELLIGENCE_GATE',
      },
    },
    COMPLETE: { type: 'final' },
  },
});
