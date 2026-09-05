import { setup, fromPromise, assign } from 'xstate';
import type { ExecuteStepResult } from '../execution/execute-step.js';
import type { IntelligenceBundle } from '../intelligence/coordinator.js';

export interface NodeMachineContext {
  nodeId: string;
  goal: string;
  complexity?: 'low' | 'medium' | 'high';
  gateAttempts?: number;
  lastResult?: ExecuteStepResult;
}

export type NodeMachineEvent =
  | { type: 'START' }
  | { type: 'SELF_EXECUTE' }
  | { type: 'DELEGATE' }
  | { type: 'DOD_MET' }
  | { type: 'DOD_NOT_MET' };

const MAX_GATE_ATTEMPTS = 3;

export const nodeMachine = setup({
  types: {
    context: {} as NodeMachineContext,
    events: {} as NodeMachineEvent,
    input: {} as NodeMachineContext,
  },
  actors: {
    executeStep: fromPromise<ExecuteStepResult, { nodeId: string; goal: string }>(async () => {
      throw new Error('executeStep actor not provided');
    }),
    assessUncertainty: fromPromise<IntelligenceBundle, { goal: string }>(async () => {
      throw new Error('assessUncertainty actor not provided');
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
      invoke: {
        src: 'assessUncertainty',
        input: ({ context }) => ({ goal: context.goal }),
        onDone: [
          {
            target: 'EXECUTION_DECISION',
            guard: ({ event }) => event.output.sufficientContext,
            actions: assign({ complexity: ({ event }) => event.output.complexity }),
          },
          // Re-planning for more context is bounded: PLAN -> GATE -> PLAN with a
          // coordinator that keeps reporting "not enough" is an infinite tight
          // loop otherwise. After MAX_GATE_ATTEMPTS we proceed on what we have
          // rather than spinning — a decision made on thin context is still a
          // decision, and it gets recorded as one.
          {
            target: 'PLAN',
            guard: ({ context }) => (context.gateAttempts ?? 0) < MAX_GATE_ATTEMPTS,
            actions: assign({
              complexity: ({ event }) => event.output.complexity,
              gateAttempts: ({ context }) => (context.gateAttempts ?? 0) + 1,
            }),
          },
          { target: 'EXECUTION_DECISION', actions: assign({ complexity: ({ event }) => event.output.complexity }) },
        ],
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
        onDone: { target: 'VERIFY', actions: assign({ lastResult: ({ event }) => event.output }) },
        // A dispatch failure is a verifiable outcome, not a crash: VERIFY gets a
        // failed result and the loop can re-plan around it.
        onError: {
          target: 'VERIFY',
          actions: assign({ lastResult: ({ event }) => ({ succeeded: false, message: String(event.error), events: [] }) }),
        },
      },
    },
    DELEGATE: { always: 'VERIFY' },
    VERIFY: {
      on: {
        DOD_MET: 'COMPLETE',
        DOD_NOT_MET: 'EXECUTION_DECISION',
      },
    },
    COMPLETE: { type: 'final' },
  },
});
