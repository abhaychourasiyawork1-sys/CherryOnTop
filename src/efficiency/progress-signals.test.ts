import { describe, it, expect } from 'vitest';
import { summarizeExecutionTrajectory, executionSnapshot, UNKNOWN_PROGRESS } from './progress-signals.js';
import { evaluateSpendGuard } from './spend-guard.js';
import type { StructuredEvent } from '../adapters/adapter.js';

let nextId = 0;

const call = (name: string, input: Record<string, unknown>): { event: StructuredEvent; id: string } => {
  const id = `t${nextId++}`;
  return {
    id,
    event: { type: 'assistant', payload: { message: { content: [{ type: 'tool_use', id, name, input }] } } } as StructuredEvent,
  };
};

const result = (id: string, isError = false, content = 'out'): StructuredEvent =>
  ({ type: 'user', payload: { message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } } } as StructuredEvent);

/** A trace as the runtime emits it: call, result, call, result. */
function trace(steps: [string, Record<string, unknown>, boolean?, string?][]): StructuredEvent[] {
  const events: StructuredEvent[] = [];
  for (const [name, input, failed, output] of steps) {
    const { event, id } = call(name, input);
    events.push(event, result(id, failed === true, output ?? 'out'));
  }
  return events;
}

describe('summarizeExecutionTrajectory — productive work', () => {
  it('reads edits followed by a green test run as progress', () => {
    const s = summarizeExecutionTrajectory(trace([
      ['Read', { file_path: 'src/a.ts' }],
      ['Edit', { file_path: 'src/a.ts' }],
      ['Edit', { file_path: 'src/b.ts' }],
      ['Bash', { command: 'npm test' }],
    ]));
    expect(s.progress).toBeGreaterThan(0.6);
    expect(s.exploration).toBeLessThan(0.4);
    expect(s.repeatedFailure).toBe(0);
  });

  it('counts a proven edit above an unproven one', () => {
    const proven = summarizeExecutionTrajectory(trace([
      ['Edit', { file_path: 'a' }], ['Edit', { file_path: 'b' }], ['Bash', { command: 'npm test' }],
    ]));
    const unproven = summarizeExecutionTrajectory(trace([
      ['Edit', { file_path: 'a' }], ['Edit', { file_path: 'b' }], ['Bash', { command: 'echo hi' }],
    ]));
    expect(proven.progress).toBeGreaterThan(unproven.progress);
  });
});

describe('summarizeExecutionTrajectory — wandering', () => {
  it('reads a read/grep loop as exploration with no progress', () => {
    const s = summarizeExecutionTrajectory(trace([
      ['Grep', { pattern: 'session' }],
      ['Read', { file_path: 'src/a.ts' }],
      ['Grep', { pattern: 'refresh' }],
      ['Read', { file_path: 'src/b.ts' }],
      ['Glob', { pattern: '**/*.ts' }],
    ]));
    expect(s.exploration).toBe(1);
    expect(s.progress).toBe(0);
  });

  it('sees the same search done over and over', () => {
    const s = summarizeExecutionTrajectory(trace([
      ['Grep', { pattern: 'session' }],
      ['Grep', { pattern: 'session' }],
      ['Grep', { pattern: 'session' }],
      ['Grep', { pattern: 'session' }],
    ]));
    expect(s.repeatedSearch).toBeGreaterThan(0.5);
  });

  it('distinguishes four different searches from the same one four times', () => {
    const varied = summarizeExecutionTrajectory(trace([
      ['Grep', { pattern: 'a' }], ['Grep', { pattern: 'b' }], ['Grep', { pattern: 'c' }], ['Grep', { pattern: 'd' }],
    ]));
    expect(varied.repeatedSearch).toBe(0);
  });

  it('sees the same command failing over and over', () => {
    const s = summarizeExecutionTrajectory(trace([
      ['Bash', { command: 'npm test' }, true],
      ['Bash', { command: 'npm test' }, true],
      ['Bash', { command: 'npm test' }, true],
      ['Bash', { command: 'npm test' }, true],
    ]));
    expect(s.repeatedFailure).toBeGreaterThan(0.5);
    expect(s.progress).toBe(0);
  });
});

describe('summarizeExecutionTrajectory — ambiguity yields the middle', () => {
  it('answers the neutral middle for an empty stream', () => {
    expect(summarizeExecutionTrajectory([])).toEqual(UNKNOWN_PROGRESS);
  });

  it('answers the neutral middle for a run that has barely started', () => {
    expect(summarizeExecutionTrajectory(trace([['Read', { file_path: 'a' }]]))).toEqual(UNKNOWN_PROGRESS);
  });

  it('does not let a run look productive by writing todo lists', () => {
    const s = summarizeExecutionTrajectory(trace([
      ['TodoWrite', {}], ['TodoWrite', {}], ['TodoWrite', {}],
      ['Grep', { pattern: 'x' }], ['Grep', { pattern: 'y' }], ['Grep', { pattern: 'z' }],
    ]));
    expect(s.progress).toBe(0);
  });

  it('gives a mixed trace a middling verdict rather than an extreme one', () => {
    const s = summarizeExecutionTrajectory(trace([
      ['Grep', { pattern: 'a' }], ['Read', { file_path: 'b' }],
      ['Edit', { file_path: 'b' }], ['Bash', { command: 'git diff' }],
    ]));
    expect(s.progress).toBeGreaterThan(0);
    expect(s.progress).toBeLessThan(0.8);
    expect(s.exploration).toBeLessThan(0.8);
  });

  it('never throws and never leaves the unit interval, on any input', () => {
    const junk = [
      {} as StructuredEvent,
      { type: 'assistant', payload: null } as StructuredEvent,
      { type: 'assistant', payload: { message: { content: 'not an array' } } } as unknown as StructuredEvent,
    ];
    const s = summarizeExecutionTrajectory(junk);
    for (const v of [s.exploration, s.progress, s.repeatedFailure, s.repeatedSearch]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('the signals against the guard', () => {
  const guard = (events: StructuredEvent[]) => {
    const s = summarizeExecutionTrajectory(events);
    return evaluateSpendGuard({
      spentUsd: 6, spendCapUsd: 10, turns: 30, softTurnTarget: 20, hardTurnCap: 60,
      explorationSignal: s.exploration, progressSignal: s.progress,
    });
  };

  it('stops a pure search loop that has burned half the budget', () => {
    expect(guard(trace([
      ['Grep', { pattern: 'session' }], ['Grep', { pattern: 'session' }],
      ['Read', { file_path: 'a' }], ['Read', { file_path: 'a' }], ['Glob', { pattern: '*' }],
    ])).state).toBe('STOP');
  });

  it('does not stop expensive work that is producing something', () => {
    expect(guard(trace([
      ['Read', { file_path: 'a' }], ['Edit', { file_path: 'a' }],
      ['Bash', { command: 'npm test' }], ['Edit', { file_path: 'b' }],
    ])).state).not.toBe('STOP');
  });

  it('does not stop on an unreadable trace', () => {
    expect(guard([]).state).not.toBe('STOP');
  });
});


describe('executionSnapshot — the fingerprint', () => {
  const at = (events: StructuredEvent[], over = {}) =>
    executionSnapshot({ events, sequence: 1, tokensConsumed: 1000, ...over });

  it('separates where the run is working from what it is looking for', () => {
    const s = at(trace([
      ['Read', { file_path: 'src/a.ts' }],
      ['Grep', { pattern: 'refreshSession' }],
      ['Edit', { file_path: 'src/b.ts' }],
    ]));
    expect(s.activeTargets).toEqual(['src/b.ts']);
    expect(s.searchTargets).toEqual(['refreshSession', 'src/a.ts']);
  });

  it('counts a green verifying command as productive and names its subject', () => {
    const s = at(trace([['Bash', { command: 'npm test' }]]));
    expect(s.productiveActions).toBe(1);
    expect(s.activeTargets).toEqual(['npm test']);
  });

  it('gives one failing command a stable signature across repetitions', () => {
    const out = 'src/a.ts(4,2): error TS2345: Argument of type X';
    const s = at(trace([
      ['Bash', { command: 'npm run typecheck' }, true, out],
      ['Bash', { command: 'npm run typecheck' }, true, out],
    ]));
    expect(new Set(s.failureSignatures).size).toBe(1);
    expect(s.failureSignatures).toHaveLength(2);
  });

  it('gives two different errors two signatures', () => {
    const s = at(trace([
      ['Bash', { command: 'npm run typecheck' }, true, 'error TS2345: one thing'],
      ['Bash', { command: 'npm run typecheck' }, true, 'error TS2741: a different thing'],
    ]));
    expect(new Set(s.failureSignatures).size).toBe(2);
  });

  it('sorts its target sets so two snapshots of one world compare equal', () => {
    const a = at(trace([['Read', { file_path: 'src/b.ts' }], ['Read', { file_path: 'src/a.ts' }]]));
    const b = at(trace([['Read', { file_path: 'src/a.ts' }], ['Read', { file_path: 'src/b.ts' }]]));
    expect(a.searchTargets).toEqual(b.searchTargets);
  });

  it('ignores bookkeeping tools, so writing todo lists is not work', () => {
    const s = at(trace([['TodoWrite', { todos: [] }], ['ExitPlanMode', {}]]));
    expect(s.totalActions).toBe(0);
    expect(s.productiveActions).toBe(0);
  });

  it('carries the evidence and validation status it was handed', () => {
    const s = at([], { knownEvidence: ['e1', 'e1', 'e2'], validationStatus: 'passed' as const });
    expect(s.knownEvidence).toEqual(['e1', 'e2']);
    expect(s.validationStatus).toBe('passed');
  });

  it('returns an empty fingerprint rather than throwing on an unreadable stream', () => {
    const s = at([{ type: 'assistant', payload: null } as unknown as StructuredEvent]);
    expect(s.activeTargets).toEqual([]);
    expect(s.totalActions).toBe(0);
  });

  it('never reports negative consumed tokens', () => {
    expect(at([], { tokensConsumed: -5 }).tokensConsumed).toBe(0);
  });
});
