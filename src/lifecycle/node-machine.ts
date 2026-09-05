import { setup, fromPromise, assign } from 'xstate';
import type { ExecuteStepResult } from '../execution/execute-step.js';
import type { IntelligenceBundle } from '../intelligence/coordinator.js';
import type { DecideExecutionResult } from '../engines/decide-execution.js';

export interface NodeMachineContext {
  nodeId: string;
  goal: string;
  complexity?: 'low' | 'medium' | 'high';
  gateAttempts?: number;
  executionAttempts?: number;
  lastDecision?: DecideExecutionResult;
  lastResult?: ExecuteStepResult;
}

// SELF_EXECUTE/DELEGATE/DOD_MET/DOD_NOT_MET are all gone from the event union —
// the machine decides and verifies these itself now. START is the only event a
// caller still sends (Task 16 adds the approval pair).
export type NodeMachineEvent =
  | { type: 'START' }
  | { type: 'APPROVED' }
  | { type: 'REJECTED' };

const MAX_GATE_ATTEMPTS = 3;
const MAX_EXECUTION_ATTEMPTS = 3;

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
    decideExecution: fromPromise<DecideExecutionResult, { goal: string; complexity: NodeMachineContext['complexity'] }>(async () => {
      throw new Error('decideExecution actor not provided');
    }),
    delegateToChild: fromPromise<ExecuteStepResult, { nodeId: string; goal: string }>(async () => {
      throw new Error('delegateToChild actor not provided');
    }),
    escalate: fromPromise<string, { nodeId: string; reason: string }>(async () => {
      throw new Error('escalate actor not provided');
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
      invoke: {
        src: 'decideExecution',
        input: ({ context }) => ({ goal: context.goal, complexity: context.complexity }),
        onDone: [
          { target: 'SELF_EXECUTE', guard: ({ event }) => event.output.outcome === 'SELF_EXECUTE', actions: assign({ lastDecision: ({ event }) => event.output }) },
          { target: 'DELEGATE', guard: ({ event }) => event.output.outcome === 'DELEGATE', actions: assign({ lastDecision: ({ event }) => event.output }) },
          { target: 'ESCALATE', actions: assign({ lastDecision: ({ event }) => event.output }) },
        ],
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
    DELEGATE: {
      invoke: {
        src: 'delegateToChild',
        input: ({ context }) => ({ nodeId: context.nodeId, goal: context.goal }),
        onDone: { target: 'VERIFY', actions: assign({ lastResult: ({ event }) => event.output }) },
        onError: {
          target: 'VERIFY',
          actions: assign({ lastResult: ({ event }) => ({ succeeded: false, message: String(event.error), events: [] }) }),
        },
      },
    },
    ESCALATE: {
      invoke: {
        src: 'escalate',
        input: ({ context }) => ({
          nodeId: context.nodeId,
          reason: 'insufficient budget for delegation',
        }),
        onDone: 'WAIT_APPROVAL',
      },
    },
    // Approval means "exceed your authority this once", so it resumes at the
    // step the authority check blocked — delegation, the only thing that
    // escalates today. Sending it back to PLAN instead would re-run the same
    // decision against the same unchanged authority and escalate again.
    WAIT_APPROVAL: {
      on: {
        APPROVED: 'DELEGATE',
        REJECTED: 'FAILED',
      },
    },
    // VERIFY resolves itself from the execution result. Nothing external sends a
    // DoD verdict: a delegating parent awaits its child's terminal state, so a
    // child parked here waiting on a human would deadlock the parent. Real
    // DoD-checking (does the result actually satisfy definition_of_done?) is a
    // later phase; today "the step succeeded" is the whole verdict.
    VERIFY: {
      always: [
        { target: 'COMPLETE', guard: ({ context }) => context.lastResult?.succeeded === true },
        {
          target: 'EXECUTION_DECISION',
          guard: ({ context }) => (context.executionAttempts ?? 0) < MAX_EXECUTION_ATTEMPTS,
          actions: assign({ executionAttempts: ({ context }) => (context.executionAttempts ?? 0) + 1 }),
        },
        { target: 'FAILED' },
      ],
    },
    COMPLETE: { type: 'final' },
    FAILED: { type: 'final' },
  },
});
