import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { claudeCodeAdapter } from './claude-code.js';

// Captured from a real `claude --print --output-format stream-json --verbose`
// run, not invented — gap G8 was found precisely because the previous fixtures
// were modelled on the stopgap adapter's made-up shape.
const REAL_FIXTURE_LINES = [
  '{"type":"system","subtype":"hook_started"}',
  '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"","signature":"abc"}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"/host/repo/file.txt"}}]}}',
  '{"type":"user","message":{"content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"1\\thello\\n"}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_2","name":"Edit","input":{"file_path":"/host/repo/file.txt","old_string":"hello\\n","new_string":"hello\\nworld\\n"}}]}}',
  '{"type":"user","message":{"content":[{"tool_use_id":"toolu_2","type":"tool_result","content":"updated"}]},"tool_use_result":{"structuredPatch":[{"oldStart":1,"oldLines":1,"newStart":1,"newLines":2,"lines":[" hello","+world"]}]}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Done."}]}}',
  '{"type":"result","total_cost_usd":0.035,"duration_api_ms":10191}',
  '{"type":"rate_limit_event"}',
];

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

  it('wraps every real Claude Code line as {type, payload: <raw line>}, losing none of them', async () => {
    const stream = Readable.from(REAL_FIXTURE_LINES.map((l) => l + '\n'));
    const events = await claudeCodeAdapter.parseEventStream(stream);
    expect(events).toHaveLength(REAL_FIXTURE_LINES.length);
    expect(events.map((e) => e.type)).toEqual([
      'system', 'assistant', 'assistant', 'user', 'assistant', 'user', 'assistant', 'result', 'rate_limit_event',
    ]);
    // The payload is the whole raw object, not a subset — the stream renderer
    // needs the real nested shape (message.content, tool_use_result, etc.).
    expect((events[2].payload as { message: { content: [{ name: string }] } }).message.content[0].name).toBe('Read');
  });

  it('parseLine returns a single wrapped event for one line, and null for a blank/malformed one', () => {
    expect(claudeCodeAdapter.parseLine('{"type":"result","total_cost_usd":0.1}')).toEqual({
      type: 'result', payload: { type: 'result', total_cost_usd: 0.1 },
    });
    expect(claudeCodeAdapter.parseLine('')).toBeNull();
    expect(claudeCodeAdapter.parseLine('not json')).toBeNull();
    expect(claudeCodeAdapter.parseLine('{"no_type_field": true}')).toBeNull();
  });

  it('discards a malformed line instead of throwing', async () => {
    const stream = Readable.from(['not valid json\n', '{"type":"result"}\n']);
    const events = await claudeCodeAdapter.parseEventStream(stream);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('result');
  });
});

describe('the tool grant reaches the runtime', () => {
  it('passes the allowlist to Claude Code, so a forbidden call is refused before it happens', () => {
    const command = claudeCodeAdapter.buildCommand('do it', { allowedTools: ['Read', 'Grep'], readOnly: true });
    expect(command).toContain('--allowedTools');
    expect(command[command.indexOf('--allowedTools') + 1]).toBe('Read,Grep');
  });

  it('adds no allowlist when the mandate sets no tool boundary', () => {
    expect(claudeCodeAdapter.buildCommand('do it', { allowedTools: null, readOnly: false }))
      .not.toContain('--allowedTools');
    expect(claudeCodeAdapter.buildCommand('do it')).not.toContain('--allowedTools');
  });

  it('keeps the goal last, whatever the grant', () => {
    expect(claudeCodeAdapter.buildCommand('do it', { allowedTools: ['Read'], readOnly: true }).at(-1)).toBe('do it');
  });
});
