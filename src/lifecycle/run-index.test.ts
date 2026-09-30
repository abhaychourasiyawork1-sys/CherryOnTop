import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../db/client.js';
import { indexRunObservations, recordRunInManifest } from './run-index.js';
import { getManifest } from '../context/runtime/task-context-manifest.js';
import type { StructuredEvent } from '../adapters/adapter.js';

const TEST_DB = './test-run-index.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const call = (id: string, name: string, input: Record<string, unknown>, output: string): StructuredEvent[] => [
  { type: 'assistant', payload: { message: { content: [{ type: 'tool_use', id, name, input }] } } },
  { type: 'user', payload: { message: { content: [{ type: 'tool_result', tool_use_id: id, content: output }] } } },
];

const grant = { allowedTools: null, readOnly: false };

describe('a finished dispatch, indexed and recorded against its task', () => {
  it('sorts what the run did into the roles the manifest has for it', () => {
    const db = createDb(TEST_DB);
    const events = [
      ...call('1', 'Read', { file_path: '/workspace/src/a.ts' }, 'export const a = 1;'),
      ...call('2', 'Edit', { file_path: '/workspace/src/a.ts', old_string: 'a', new_string: 'b' }, 'ok'),
      ...call('3', 'Bash', { command: 'npm test' }, '3 passed'),
      ...call('4', 'Bash', { command: 'ls -la' }, 'total 0'),
    ];
    const indexed = indexRunObservations(db, { nodeId: 'n1', events, eventIds: [1, 2, 3, 4, 5, 6, 7, 8], grant });
    expect(indexed.observations).toBe(4);
    expect(indexed.sections.artifacts).toHaveLength(1);
    expect(indexed.sections.validation).toHaveLength(1);

    const update = recordRunInManifest(db, 'task-1', indexed);
    expect(update?.changed).toBe(true);
    const manifest = getManifest(db, 'task-1')!;
    expect(manifest.validation).toHaveLength(1);
    expect(manifest.artifacts).toHaveLength(1);
    // A directory listing is neither a check nor something the task produced.
    expect(manifest.facts).toHaveLength(0);
  });

  it('keeps a failed check as validation evidence, but not a failed edit as something produced', () => {
    const db = createDb(TEST_DB);
    const failedTest: StructuredEvent[] = [
      { type: 'assistant', payload: { message: { content: [{ type: 'tool_use', id: '9', name: 'Bash', input: { command: 'npm test' } }] } } },
      { type: 'user', payload: { message: { content: [{ type: 'tool_result', tool_use_id: '9', is_error: true, content: '2 failed' }] } } },
    ];
    const failedEdit: StructuredEvent[] = [
      { type: 'assistant', payload: { message: { content: [{ type: 'tool_use', id: '8', name: 'Edit', input: { file_path: '/workspace/x.ts' } }] } } },
      { type: 'user', payload: { message: { content: [{ type: 'tool_result', tool_use_id: '8', is_error: true, content: 'no match' }] } } },
    ];
    const indexed = indexRunObservations(db, { nodeId: 'n1', events: [...failedTest, ...failedEdit], eventIds: [1, 2, 3, 4], grant });
    expect(indexed.sections.validation).toHaveLength(1);
    expect(indexed.sections.artifacts).toHaveLength(0);
  });

  it('records nothing, without error, for a run that observed nothing', () => {
    const db = createDb(TEST_DB);
    const indexed = indexRunObservations(db, { nodeId: 'n1', events: [], eventIds: [], grant });
    expect(recordRunInManifest(db, 'task-1', indexed)).toBeNull();
    expect(getManifest(db, 'task-1')).toBeNull();
  });

  it('does not move the manifest when the same run is recorded twice', () => {
    const db = createDb(TEST_DB);
    const events = call('3', 'Bash', { command: 'npm test' }, '3 passed');
    const first = recordRunInManifest(db, 'task-1', indexRunObservations(db, { nodeId: 'n1', events, eventIds: [1, 2], grant }));
    const second = recordRunInManifest(db, 'task-1', indexRunObservations(db, { nodeId: 'n1', events, eventIds: [1, 2], grant }));
    expect(first?.manifest.revision).toBe(1);
    expect(second?.changed).toBe(false);
  });
});
