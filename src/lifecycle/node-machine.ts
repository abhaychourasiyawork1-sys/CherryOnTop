import { setup, fromPromise, assign } from 'xstate';
import type { ExecuteStepResult } from '../execution/execute-step.js';
import type { IntelligenceBundle } from '../intelligence/coordinator.js';
import type { DecideExecutionResult } from '../engines/decide-execution.js';

export interface NodeMachineContext {
  nodeId: string;
  goal: string;
  complexity?: 'low' | 'medium' | 'high';
  worthSplitting?: boolean;
  signals?: Record<string, number>;
  gateAttempts?: number;
  executionAttempts?: number;
  lastDecision?: DecideExecutionResult;
  /** Set only by a human approval: the budget a node may spend on a child despite
   *  its own authority being too small. Undefined means "stay inside authority". */
  approvedBudgetUsd?: number;
  lastResult?: ExecuteStepResult;
}

// SELF_EXECUTE/DELEGATE/DOD_MET/DOD_NOT_MET are all gone from the event union —
// the machine decides and verifies these itself now. START is the only event a
// caller still sends (Task 16 adds the approval pair).
export type NodeMachineEvent =
  | { type: 'START' }
  | { type: 'APPROVED' }
  | { type: 'REJECTED' }
  | { type: 'CANCEL' };

function money(value: number | undefined): string {
  return value === undefined ? '?' : value.toFixed(2);
}

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
    decideExecution: fromPromise<DecideExecutionResult, {
      goal: string;
      complexity: NodeMachineContext['complexity'];
      worthSplitting?: boolean;
      signals?: Record<string, number>;
    }>(async () => {
      throw new Error('decideExecution actor not provided');
    }),
    delegateToChild: fromPromise<ExecuteStepResult, { nodeId: string; goal: string; approvedBudgetUsd?: number }>(async () => {
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
  // Root-level, so every state is cancellable — mid-execute, mid-delegate,
  // parked on approval — without editing each one, and without a state added
  // later being silently un-cancellable because someone forgot. Final states
  // ignore it, so cancelling a finished node is a no-op rather than a rewrite.
  on: { CANCEL: '.CANCELLED' },
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
            actions: assign({
              complexity: ({ event }) => event.output.complexity,
              worthSplitting: ({ event }) => event.output.worthSplitting,
              signals: ({ event }) => event.output.signals,
            }),
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
              worthSplitting: ({ event }) => event.output.worthSplitting,
              signals: ({ event }) => event.output.signals,
              gateAttempts: ({ context }) => (context.gateAttempts ?? 0) + 1,
            }),
          },
          {
            target: 'EXECUTION_DECISION',
            actions: assign({
              complexity: ({ event }) => event.output.complexity,
              worthSplitting: ({ event }) => event.output.worthSplitting,
              signals: ({ event }) => event.output.signals,
            }),
          },
        ],
      },
    },
    EXECUTION_DECISION: {
      invoke: {
        src: 'decideExecution',
        input: ({ context }) => ({
          goal: context.goal,
          complexity: context.complexity,
          worthSplitting: context.worthSplitting,
          signals: context.signals,
        }),
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
        input: ({ context }) => ({
          nodeId: context.nodeId, goal: context.goal, approvedBudgetUsd: context.approvedBudgetUsd,
        }),
        onDone: [
          // A goal that does not split is not a failed delegation, it is a goal
          // to do yourself. Sending it to VERIFY instead made it a failure the
          // machine retried — re-planning, reaching the same answer, three times
          // over, and paying for a sandbox on each pass.
          {
            target: 'SELF_EXECUTE',
            guard: ({ event }) => event.output.notDelegatable === true,
            actions: assign({ lastResult: ({ event }) => event.output }),
          },
          { target: 'VERIFY', actions: assign({ lastResult: ({ event }) => event.output }) },
        ],
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
          // Read by a person, in a desktop notification and an approval queue —
          // so it says what is being asked for, not which enum the machine was
          // in when it asked.
          reason: context.lastDecision
            ? `Needs $${money(context.lastDecision.breakdown.requiredBudget)} to delegate this, authorized for $${money(context.lastDecision.breakdown.availableBudget)}`
            : 'Reached the edge of its authority',
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
        APPROVED: {
          target: 'DELEGATE',
          // Approval has to grant something, or the child is created inside the
          // same authority that blocked it and the approval was theatre.
          actions: assign({
            approvedBudgetUsd: ({ context }) => context.lastDecision?.breakdown.requiredBudget ?? 1,
          }),
        },
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
    // A cancelled node is not a failed one: nothing went wrong with it, a human
    // stopped it. Keeping them distinct is what makes `org tree` honest.
    CANCELLED: { type: 'final' },
  },
});
