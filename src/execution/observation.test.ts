import { describe, it, expect } from 'vitest';
import { observationsFromEvents, operationOf, observationBytes } from './observation.js';

const call = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  payload: { message: { content: [{ type: 'tool_use', id, name, input }] } },
});

const result = (toolUseId: string, content: unknown, isError = false) => ({
  type: 'user',
  payload: { message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] } },
});

describe('recovering observations from a runtime stream', () => {
  it('pairs a call with its result', () => {
    const [observation] = observationsFromEvents([
      call('t1', 'Read', { file_path: '/workspace/src/a.ts' }),
      result('t1', 'export const a = 1;'),
    ], 'n1');

    expect(observation.tool.name).toBe('Read');
    expect(observation.invocation.input.file_path).toBe('/workspace/src/a.ts');
    expect(observation.raw).toBe('export const a = 1;');
    expect(observation.execution).toMatchObject({ nodeId: 'n1', succeeded: true });
  });

  it('keeps a call that never got a result', () => {
    // A run cut off mid-tool is exactly the case worth being able to see.
    // Dropping it would make a truncated run look like one that never tried.
    const [observation] = observationsFromEvents([call('t1', 'Bash', { command: 'sleep 600' })], 'n1');
    expect(observation.raw).toBe('');
    expect(observation.execution.succeeded).toBe(false);
  });

  it('records a failed tool call as failed rather than as absent', () => {
    const [observation] = observationsFromEvents([
      call('t1', 'Bash', { command: 'exit 1' }),
      result('t1', 'command failed', true),
    ], 'n1');
    expect(observation.execution.succeeded).toBe(false);
    expect(observation.raw).toBe('command failed');
  });

  it('reads a result delivered as content blocks, not only as a string', () => {
    const [observation] = observationsFromEvents([
      call('t1', 'Read', { file_path: 'a.ts' }),
      result('t1', [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }]),
    ], 'n1');
    expect(observation.raw).toBe('line one\nline two');
  });

  it('gives the same call the same identity, so re-observing does not fork the graph', () => {
    const events = [call('t1', 'Read', { file_path: 'a.ts' }), result('t1', 'x')];
    const again = [call('t9', 'Read', { file_path: 'a.ts' }), result('t9', 'x')];
    expect(observationsFromEvents(events, 'n1')[0].semanticId)
      .toBe(observationsFromEvents(again, 'n2')[0].semanticId);
    // ...and a different call a different one.
    expect(observationsFromEvents([call('t1', 'Read', { file_path: 'b.ts' }), result('t1', 'x')], 'n1')[0].semanticId)
      .not.toBe(observationsFromEvents(events, 'n1')[0].semanticId);
  });

  it('orders observations without needing a clock', () => {
    const observations = observationsFromEvents([
      call('t1', 'Read', { file_path: 'a.ts' }),
      result('t1', 'a'),
      call('t2', 'Read', { file_path: 'b.ts' }),
      result('t2', 'b'),
    ], 'n1');
    expect(observations.map((o) => o.execution.sequence)).toEqual([0, 2]);
  });

  it('sums the raw output a run produced', () => {
    const observations = observationsFromEvents([
      call('t1', 'Read', { file_path: 'a.ts' }), result('t1', 'x'.repeat(100)),
      call('t2', 'Read', { file_path: 'b.ts' }), result('t2', 'y'.repeat(50)),
    ], 'n1');
    expect(observationBytes(observations)).toBe(150);
  });
});

describe('operationOf', () => {
  it('recovers the operation inside a shell command, because git status and git diff are not the same output', () => {
    expect(operationOf('Bash', { command: 'git status --porcelain' })).toBe('git/status');
    expect(operationOf('Bash', { command: '  git   diff HEAD' })).toBe('git/diff');
    expect(operationOf('Bash', { command: 'ls' })).toBe('ls');
    expect(operationOf('Read', { file_path: 'a.ts' })).toBeUndefined();
    expect(operationOf('Bash', { command: '' })).toBeUndefined();
  });
});
