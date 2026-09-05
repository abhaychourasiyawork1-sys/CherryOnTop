import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { claudeCodeAdapter } from './claude-code.js';

describe('claudeCodeAdapter', () => {
  // Regression: the real binary rejects `--print --output-format stream-json`
  // without --verbose, and auto-denies every edit without a permission mode, so
  // both flags are load-bearing, not cosmetic.
  it('builds the headless streaming command for a goal', () => {
    const command = claudeCodeAdapter.buildCommand('implement OAuth login');
    expect(command).toEqual([
      'claude', '--print', '--output-format', 'stream-json', '--verbose',
      '--dangerously-skip-permissions', 'implement OAuth login',
    ]);
  });

  it('parses a stream of ndjson events into structured events', async () => {
    const lines = [
      JSON.stringify({ type: 'message', payload: { text: 'starting' } }),
      JSON.stringify({ type: 'tool_call', payload: { tool: 'bash', args: ['ls'] } }),
      JSON.stringify({ type: 'result', payload: { success: true } }),
    ];
    const stream = Readable.from(lines.map((l) => l + '\n'));

    const events = await claudeCodeAdapter.parseEventStream(stream);
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('message');
    expect(events[2].payload).toEqual({ success: true });
  });

  it('discards a malformed line instead of throwing', async () => {
    const stream = Readable.from(['not valid json\n', JSON.stringify({ type: 'message', payload: {} }) + '\n']);
    const events = await claudeCodeAdapter.parseEventStream(stream);
    expect(events).toHaveLength(1);
  });

  it('discards a well-formed JSON line that is not a structured event', async () => {
    const stream = Readable.from(['{"nope":1}\n', JSON.stringify({ type: 'result', payload: {} }) + '\n']);
    const events = await claudeCodeAdapter.parseEventStream(stream);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('result');
  });
});
