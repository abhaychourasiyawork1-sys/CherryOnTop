import { setup, fromPromise, assign } from 'xstate';
import type { ExecuteStepResult } from '../execution/execute-step.js';
import { ZERO_USAGE } from '../execution/tokens.js';
import type { IntelligenceBundle } from '../intelligence/coordinator.js';
import type { DecideExecutionResult } from '../engines/decide-execution.js';
import { nextAfterValidation, type ValidationResult } from '../validation/engine.js';
import { strategyRetryAllowed } from '../recovery/engine.js';

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
  /** What validation concluded about the last execution. The only thing that
   *  may open the door to COMPLETE. */
  lastValidation?: ValidationResult;
  /** How each previous attempt died, and under which strategy. Kept so the
   *  machine can tell a *recovery* from a repeat: re-running the same strategy
   *  into the same wall with nothing gained is not an attempt, it is a bill. */
  failureSignatures?: string[];
  strategies?: string[];
  /** How far the last attempt got. Progress is what makes a repeat of the same
   *  strategy a genuinely different attempt. */
  progress?: number;
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

/** What the validate actor hands back: the verdict, plus the strategy identity
 *  recovery needs to tell a new attempt from a repeat of the last one. The
 *  extra fields are optional so a caller that only has a verdict still works —
 *  it just gets the old, cap-bounded retry behaviour. */
export interface ValidationVerdict extends ValidationResult {
  strategy?: string;
  failureSignature?: string;
  progress?: number;
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
    /** Buys the cheapest evidence that clears this task's contract. Injected so
     *  the machine holds no opinion about what counts as proof, and so a
     *  deployment with no verifier still validates — at V2, and says so. */
    validate: fromPromise<ValidationVerdict, { nodeId: string; goal: string; succeeded: boolean }>(async () => {
      throw new Error('validate actor not provided');
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
        onDone: { target: 'VALIDATE', actions: assign({ lastResult: ({ event }) => event.output }) },
        // A dispatch failure is a verifiable outcome, not a crash: VALIDATE gets a
        // failed result and the loop can re-plan around it.
        onError: {
          target: 'VALIDATE',
          actions: assign({ lastResult: ({ event }) => ({ succeeded: false, message: String(event.error), events: [], usage: { ...ZERO_USAGE } }) }),
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
          // to do yourself. Sending it to VALIDATE instead made it a failure the
          // machine retried — re-planning, reaching the same answer, three times
          // over, and paying for a sandbox on each pass.
          {
            target: 'SELF_EXECUTE',
            guard: ({ event }) => event.output.notDelegatable === true,
            actions: assign({ lastResult: ({ event }) => event.output }),
          },
          { target: 'VALIDATE', actions: assign({ lastResult: ({ event }) => event.output }) },
        ],
        onError: {
          target: 'VALIDATE',
          actions: assign({ lastResult: ({ event }) => ({ succeeded: false, message: String(event.error), events: [], usage: { ...ZERO_USAGE } }) }),
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
    // The only door into COMPLETE, and the reason there is one.
    //
    // `EXECUTION_FINISHED` is a fact about a process; `TASK_SUCCESS` is a claim
    // about the world. This state is where the second is bought from the first,
    // and it can refuse: a run that finished, produced nothing durable, and
    // cannot point at a check is not a success however cleanly it exited. The
    // primary KPI is tokens per *successful* task, so a success count that
    // includes runs which did not work scores an optimizer that makes runs
    // cheaper and wronger as an improvement. That is the failure this state
    // exists to make unreachable.
    //
    // Nothing external sends a verdict: a delegating parent awaits its child's
    // terminal state, so a child parked here waiting on a human would deadlock
    // the parent.
    VALIDATE: {
      invoke: {
        src: 'validate',
        input: ({ context }) => ({
          nodeId: context.nodeId, goal: context.goal,
          succeeded: context.lastResult?.succeeded === true,
        }),
        onDone: [
          {
            target: 'COMPLETE',
            guard: ({ context, event }) => nextAfterValidation({
              executionSucceeded: context.lastResult?.succeeded === true,
              validation: event.output,
              executionAttempts: context.executionAttempts ?? 0,
              retriable: context.lastResult?.rateLimited !== true,
            }) === 'COMPLETE',
            actions: assign({ lastValidation: ({ event }) => event.output }),
          },
          {
            target: 'EXECUTION_DECISION',
            guard: ({ context, event }) => nextAfterValidation({
              executionSucceeded: context.lastResult?.succeeded === true,
              validation: event.output,
              executionAttempts: context.executionAttempts ?? 0,
              retriable: context.lastResult?.rateLimited !== true,
            }) === 'RECOVER'
              // ...and only if the next attempt would be a different one. The
              // attempt cap alone bounds the *number* of identical retries; it
              // does not stop the first of them being pointless.
              && strategyRetryAllowed({
                currentStrategy: event.output.strategy ?? 'MANAGED',
                previousStrategies: context.strategies ?? [],
                failureSignature: event.output.failureSignature ?? 'unknown',
                previousFailureSignatures: context.failureSignatures ?? [],
                progress: event.output.progress ?? 0,
              }),
            actions: assign({
              lastValidation: ({ event }) => event.output,
              executionAttempts: ({ context }) => (context.executionAttempts ?? 0) + 1,
              strategies: ({ context, event }) => [...(context.strategies ?? []), event.output.strategy ?? 'MANAGED'],
              failureSignatures: ({ context, event }) =>
                [...(context.failureSignatures ?? []), event.output.failureSignature ?? 'unknown'],
              progress: ({ event }) => event.output.progress ?? 0,
            }),
          },
          { target: 'FAILED', actions: assign({ lastValidation: ({ event }) => event.output }) },
        ],
        // Unreadable evidence must not manufacture a success. It also must not
        // manufacture a *crash*: the run finished, and the honest reading is
        // that we cannot say whether it worked.
        onError: [
          {
            target: 'EXECUTION_DECISION',
            guard: ({ context }) => context.lastResult?.rateLimited !== true
              && (context.executionAttempts ?? 0) < MAX_EXECUTION_ATTEMPTS,
            actions: assign({ executionAttempts: ({ context }) => (context.executionAttempts ?? 0) + 1 }),
          },
          { target: 'FAILED' },
        ],
      },
    },
    COMPLETE: { type: 'final' },
    FAILED: { type: 'final' },
    // A cancelled node is not a failed one: nothing went wrong with it, a human
    // stopped it. Keeping them distinct is what makes `org tree` honest.
    CANCELLED: { type: 'final' },
  },
});
