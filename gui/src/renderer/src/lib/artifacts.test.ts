import { describe, it, expect } from 'vitest';
import { presentationOf, fileIndex, changeFromEvent, lineDiff, displayPath } from './artifacts.js';

describe('artifacts', () => {
  it('maps artifact types to presentation modes', () => {
    expect(presentationOf('src/a.ts')).toBe('code');
    expect(presentationOf('README.md')).toBe('markdown');
    expect(presentationOf('chart.PNG')).toBe('image');
    expect(presentationOf('report.pdf')).toBe('pdf');
    expect(presentationOf('rows.csv')).toBe('table');
    expect(presentationOf('flow.mmd')).toBe('diagram');
    expect(displayPath('/workspace/src/a.ts')).toBe('src/a.ts');
  });

  it('indexes files with their provenance, newest first', () => {
    const files = fileIndex([
      { id: '1', nodeId: 'n1', caseId: 'c1', kind: 'file_edit', path: '/workspace/a.ts', summary: '', createdAt: '2026-09-01T00:00:01Z', eventId: 10 },
      { id: '2', nodeId: 'n2', caseId: 'c2', kind: 'file_write', path: '/workspace/b.md', summary: '', createdAt: '2026-09-01T00:00:03Z' },
      { id: '3', nodeId: 'n1', caseId: 'c1', kind: 'file_edit', path: '/workspace/a.ts', summary: '', createdAt: '2026-09-01T00:00:02Z' },
      { id: '4', nodeId: 'n1', caseId: 'c1', kind: 'command', path: null, summary: 'ls' },
    ]);
    expect(files.map((f) => [f.display, f.changes.length])).toEqual([['b.md', 1], ['a.ts', 2]]);
    expect(files[1].changes[0]).toMatchObject({ artifactId: '3', caseId: 'c1', nodeId: 'n1' });
    expect(files[1].changes[1].eventId).toBe(10);
  });

  it('reads the change itself from the tool call', () => {
    const event = {
      id: 1, nodeId: 'n', type: 'exec.assistant', createdAt: '',
      payload: { message: { content: [
        { type: 'text', text: 'editing' },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/workspace/a.ts', old_string: 'x', new_string: 'y' } },
      ] } },
    };
    expect(changeFromEvent(event, '/workspace/a.ts')).toEqual({ kind: 'edit', before: 'x', after: 'y' });
    expect(changeFromEvent(event, '/workspace/other.ts')).toBeNull();
    expect(changeFromEvent(undefined, 'x')).toBeNull();
    const onDisk = { id: 2, nodeId: 'n', type: 'exec.file_change', createdAt: '', payload: { path: 'b.ts', before: 'p', after: 'q' } };
    expect(changeFromEvent(onDisk, 'b.ts')).toEqual({ kind: 'edit', before: 'p', after: 'q' });
  });

  it('diffs by line', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual([
      { sign: 'context', text: 'a' },
      { sign: 'remove', text: 'b' },
      { sign: 'add', text: 'B' },
      { sign: 'context', text: 'c' },
    ]);
    expect(lineDiff('a\nb', 'c', 1)).toHaveLength(3);
  });
});
