import { DEMO_COUNTERS, DEMO_STATE_SEQUENCE } from './data';
import type { DemoEvent, DemoSnapshot, DemoState } from './types';

export function createInitialSnapshot(): DemoSnapshot {
  return {
    state: 'goal',
    activeNodeId: null,
    counters: DEMO_COUNTERS.goal,
    approvalRequired: false,
    receiptVisible: false,
    memoryRun: null,
  };
}

function nextState(state: DemoState): DemoState {
  const index = DEMO_STATE_SEQUENCE.indexOf(state);
  const nextIndex = Math.min(index + 1, DEMO_STATE_SEQUENCE.length - 1);
  return DEMO_STATE_SEQUENCE[nextIndex];
}

function withState(snapshot: DemoSnapshot, state: DemoState): DemoSnapshot {
  return {
    ...snapshot,
    state,
    activeNodeId: null,
    counters: DEMO_COUNTERS[state],
    approvalRequired: state === 'mandate',
    receiptVisible: state === 'receipt' || state === 'memory',
    memoryRun: state === 'memory' ? snapshot.memoryRun ?? 1 : snapshot.memoryRun,
  };
}

/**
 * Pure, deterministic, side-effect free. This is the only source of truth for
 * the demo lifecycle; timing/animation belongs to the controller, not here.
 */
export function transition(snapshot: DemoSnapshot, event: DemoEvent): DemoSnapshot {
  switch (event.type) {
    case 'NEXT':
      return withState(snapshot, nextState(snapshot.state));
    case 'RESET':
      return createInitialSnapshot();
    case 'REPLAY': {
      const initial = createInitialSnapshot();
      return { ...initial, memoryRun: snapshot.memoryRun ? 2 : null };
    }
    case 'INSPECT_NODE':
      return { ...snapshot, activeNodeId: event.nodeId };
    case 'CLOSE_INSPECTOR':
      return { ...snapshot, activeNodeId: null };
    default:
      return snapshot;
  }
}
