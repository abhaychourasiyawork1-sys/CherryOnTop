import { describe, it, expect } from 'vitest';
import { artifactsFromEvent } from './artifacts.js';

function assistant(blocks: unknown[]) {
  return { type: 'assistant', payload: { type: 'assistant', message: { content: blocks } } };
}

describe('artifactsFromEvent', () => {
  it('records a file artifact per file-touching tool call', () => {
    const artifacts = artifactsFromEvent(assistant([
      { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/repo/b.ts' } },
      { type: 'tool_use', id: 't3', name: 'NotebookEdit', input: { notebook_path: '/repo/c.ipynb' } },
    ]));
    expect(artifacts).toEqual([
      { kind: 'file_write', path: '/repo/a.ts', summary: 'Write' },
      { kind: 'file_edit', path: '/repo/b.ts', summary: 'Edit' },
      { kind: 'file_edit', path: '/repo/c.ipynb', summary: 'NotebookEdit' },
    ]);
  });

  it('records a command artifact for Bash, keeping the command as the summary', () => {
    expect(artifactsFromEvent(assistant([
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
    ]))).toEqual([{ kind: 'command', path: null, summary: 'npm test' }]);
  });

  it('ignores read-only tools — an artifact is something the run produced', () => {
    expect(artifactsFromEvent(assistant([
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'x' } },
      { type: 'text', text: 'thinking out loud' },
    ]))).toEqual([]);
  });

  it('records the run result, with its cost, as an artifact', () => {
    expect(artifactsFromEvent({
      type: 'result',
      payload: { type: 'result', subtype: 'success', total_cost_usd: 0.035, result: 'Done.' },
    })).toEqual([{ kind: 'result', path: null, summary: 'Done. ($0.0350)' }]);
  });

  it('falls back to the subtype when a result carries no text', () => {
    expect(artifactsFromEvent({ type: 'result', payload: { subtype: 'error_max_turns' } }))
      .toEqual([{ kind: 'result', path: null, summary: 'error_max_turns ($0.0000)' }]);
  });

  it('returns nothing for events that produced nothing', () => {
    expect(artifactsFromEvent({ type: 'system', payload: {} })).toEqual([]);
    expect(artifactsFromEvent({ type: 'assistant', payload: {} })).toEqual([]);
  });
});
