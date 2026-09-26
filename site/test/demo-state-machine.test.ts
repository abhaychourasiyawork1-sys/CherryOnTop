import { describe, expect, it } from 'vitest';
import { createInitialSnapshot, transition } from '../src/demo/state-machine';
import type { DemoState } from '../src/demo/types';

function next(snapshot: ReturnType<typeof createInitialSnapshot>) {
  return transition(snapshot, { type: 'NEXT' });
}

describe('demo state machine', () => {
  it('walks the exact locked sequence without skipping failure or recovery', () => {
    const expectedSequence: DemoState[] = [
      'goal',
      'organization',
      'mandate',
      'executing',
      'failure',
      'recovering',
      'validating',
      'verified',
      'receipt',
    ];

    let snapshot = createInitialSnapshot();
    expect(snapshot.state).toBe('goal');

    const visited: DemoState[] = [snapshot.state];
    for (let i = 1; i < expectedSequence.length; i += 1) {
      snapshot = next(snapshot);
      visited.push(snapshot.state);
    }

    expect(visited).toEqual(expectedSequence);
  });

  it('never allows a transition straight from executing to validating or verified', () => {
    let snapshot = createInitialSnapshot();
    snapshot = next(snapshot); // organization
    snapshot = next(snapshot); // mandate
    snapshot = next(snapshot); // executing
    expect(snapshot.state).toBe('executing');

    snapshot = next(snapshot);
    expect(snapshot.state).toBe('failure');
    expect(snapshot.state).not.toBe('validating');
    expect(snapshot.state).not.toBe('verified');

    snapshot = next(snapshot);
    expect(snapshot.state).toBe('recovering');
  });

  it('keeps receiptVisible false until the receipt state, including at verified', () => {
    let snapshot = createInitialSnapshot();
    const statesBeforeReceipt: DemoState[] = [
      'goal',
      'organization',
      'mandate',
      'executing',
      'failure',
      'recovering',
      'validating',
      'verified',
    ];

    for (const state of statesBeforeReceipt) {
      expect(snapshot.state).toBe(state);
      expect(snapshot.receiptVisible).toBe(false);
      snapshot = next(snapshot);
    }

    expect(snapshot.state).toBe('receipt');
    expect(snapshot.receiptVisible).toBe(true);
  });

  it('produces a final verified snapshot with the locked illustrative values 47/47 and $2.31 of $5.00', () => {
    let snapshot = createInitialSnapshot();
    while (snapshot.state !== 'verified') {
      snapshot = next(snapshot);
    }

    expect(snapshot.counters.checks).toBe(47);
    expect(snapshot.counters.checksPassed).toBe(47);
    expect(`$${snapshot.counters.spend.toFixed(2)}`).toBe('$2.31');
    expect(`$${snapshot.counters.budget.toFixed(2)}`).toBe('$5.00');
  });

  it('inspecting a node never mutates the lifecycle state', () => {
    let snapshot = createInitialSnapshot();
    snapshot = next(snapshot); // organization

    const beforeState = snapshot.state;
    const beforeCounters = snapshot.counters;

    const inspected = transition(snapshot, { type: 'INSPECT_NODE', nodeId: 'frontend' });
    expect(inspected.state).toBe(beforeState);
    expect(inspected.counters).toEqual(beforeCounters);
    expect(inspected.activeNodeId).toBe('frontend');

    const closed = transition(inspected, { type: 'CLOSE_INSPECTOR' });
    expect(closed.state).toBe(beforeState);
    expect(closed.activeNodeId).toBeNull();
  });

  it('resets to the initial snapshot on RESET', () => {
    let snapshot = createInitialSnapshot();
    snapshot = next(snapshot);
    snapshot = next(snapshot);

    const reset = transition(snapshot, { type: 'RESET' });
    expect(reset).toEqual(createInitialSnapshot());
  });

  it('replays the sequence from goal and marks the second memory run', () => {
    let snapshot = createInitialSnapshot();
    for (let i = 0; i < 9; i += 1) {
      snapshot = next(snapshot); // walk all the way to memory
    }
    expect(snapshot.state).toBe('memory');
    expect(snapshot.memoryRun).toBe(1);

    let replayed = transition(snapshot, { type: 'REPLAY' });
    expect(replayed.state).toBe('goal');
    expect(replayed.memoryRun).toBe(2);

    for (let i = 0; i < 9; i += 1) {
      replayed = next(replayed);
    }
    expect(replayed.state).toBe('memory');
    expect(replayed.memoryRun).toBe(2);
  });

  it('is a pure function: calling transition twice with the same input yields equal output', () => {
    const snapshot = createInitialSnapshot();
    const a = transition(snapshot, { type: 'NEXT' });
    const b = transition(snapshot, { type: 'NEXT' });
    expect(a).toEqual(b);
    expect(snapshot.state).toBe('goal');
  });
});
