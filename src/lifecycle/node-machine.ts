import { setup } from 'xstate';

export interface NodeMachineContext {
  nodeId: string;
  goal: string;
}

export type NodeMachineEvent =
  | { type: 'START' }
  | { type: 'CONTEXT_SUFFICIENT' }
  | { type: 'CONTEXT_INSUFFICIENT' }
  | { type: 'SELF_EXECUTE' }
  | { type: 'DELEGATE' }
  | { type: 'DOD_MET' }
  | { type: 'DOD_NOT_MET' };

// Phase 1 skeleton: ORIENT/PLAN/SELF_EXECUTE/DELEGATE pass straight through and the
// caller drives the decision events. Phase 2/3 replace those with invoked actors
// (execute-step, economics, intelligence) without changing these state names.
export const nodeMachine = setup({
  types: {
    context: {} as NodeMachineContext,
    events: {} as NodeMachineEvent,
    input: {} as NodeMachineContext,
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
    SELF_EXECUTE: { always: 'VERIFY' },
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
