import { describe, it, expect } from 'vitest';
import { createStreamRenderer } from './stream-renderer.js';
import type { StructuredEvent } from '../adapters/adapter.js';

function wrap(raw: object): StructuredEvent {
  return { type: (raw as { type: string }).type, payload: raw };
}

describe('createStreamRenderer', () => {
  it('appends assistant text as a text line', () => {
    const [result] = createStreamRenderer().feed(wrap({
      type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] },
    }));
    expect(result.action).toBe('append');
    expect(result.line.kind).toBe('text');
    expect(result.line.content).toBe('Done.');
  });

  it('skips an empty thinking block', () => {
    expect(createStreamRenderer().feed(wrap({
      type: 'assistant', message: { content: [{ type: 'thinking', thinking: '', signature: 'x' }] },
    }))).toEqual([]);
  });

  it('renders non-empty thinking as its own line kind', () => {
    const [result] = createStreamRenderer().feed(wrap({
      type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'considering the approach', signature: 'x' }] },
    }));
    expect(result.line.kind).toBe('thinking');
    expect(result.line.content).toBe('considering the approach');
  });

  it('appends a pending tool-use line, keyed by the tool_use id', () => {
    const [result] = createStreamRenderer().feed(wrap({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/host/repo/file.txt' } }] },
    }));
    expect(result.action).toBe('append');
    expect(result.line.key).toBe('toolu_1');
    expect(result.line.kind).toBe('tool-pending');
    expect(result.line.content).toBe('Read /host/repo/file.txt');
  });

  it('emits one result per content block when a message carries several', () => {
    const results = createStreamRenderer().feed(wrap({
      type: 'assistant',
      message: { content: [
        { type: 'text', text: 'Let me look.' },
        { type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'ls' } },
      ] },
    }));
    expect(results.map((r) => r.line.kind)).toEqual(['text', 'tool-pending']);
  });

  it('resolves a pending tool call into a diff when the matching tool_result carries a structuredPatch', () => {
    const renderer = createStreamRenderer();
    renderer.feed(wrap({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'Edit', input: { file_path: '/host/repo/file.txt' } }] },
    }));

    const [result] = renderer.feed(wrap({
      type: 'user',
      message: { content: [{ tool_use_id: 'toolu_2', type: 'tool_result', content: 'updated' }] },
      tool_use_result: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' hello', '+world'] }] },
    }));

    expect(result.action).toBe('update');
    expect(result.line.key).toBe('toolu_2');
    expect(result.line.kind).toBe('diff');
    expect(result.line.diffLines).toEqual([' hello', '+world']);
  });

  it('resolves a pending tool call into tool-done when there is no structuredPatch', () => {
    const renderer = createStreamRenderer();
    renderer.feed(wrap({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_3', name: 'Read', input: { file_path: '/x' } }] },
    }));
    const [result] = renderer.feed(wrap({
      type: 'user',
      message: { content: [{ tool_use_id: 'toolu_3', type: 'tool_result', content: '1\thello\n' }] },
    }));
    expect(result.action).toBe('update');
    expect(result.line.kind).toBe('tool-done');
  });

  it('skips a tool_result with no matching pending call', () => {
    expect(createStreamRenderer().feed(wrap({
      type: 'user',
      message: { content: [{ tool_use_id: 'unknown', type: 'tool_result', content: 'x' }] },
    }))).toEqual([]);
  });

  it('renders a result event as a cost summary line', () => {
    const [result] = createStreamRenderer().feed(wrap({ type: 'result', total_cost_usd: 0.0354 }));
    expect(result.line.kind).toBe('summary');
    expect(result.line.content).toContain('0.0354');
  });

  it('skips system and rate_limit_event noise', () => {
    const renderer = createStreamRenderer();
    expect(renderer.feed(wrap({ type: 'system', subtype: 'hook_started' }))).toEqual([]);
    expect(renderer.feed(wrap({ type: 'rate_limit_event' }))).toEqual([]);
  });
});
