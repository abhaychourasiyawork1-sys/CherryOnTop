import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { codexAdapter } from './codex.js';

describe('codexAdapter', () => {
  it('runs headlessly with machine-readable output', () => {
    const command = codexAdapter.buildCommand('fix the bug');
    expect(command[0]).toBe('codex');
    expect(command).toContain('--json');
    expect(command.at(-1)).toBe('fix the bug');
  });

  it('wraps a line as the payload, keeping type as the discriminator', () => {
    expect(codexAdapter.parseLine('{"type":"item.completed","item":{"id":"1"}}')).toEqual({
      type: 'item.completed',
      payload: { type: 'item.completed', item: { id: '1' } },
    });
  });

  it('treats malformed and typeless lines as noise, not failure', () => {
    expect(codexAdapter.parseLine('')).toBeNull();
    expect(codexAdapter.parseLine('not json')).toBeNull();
    expect(codexAdapter.parseLine('{"no":"type"}')).toBeNull();
    expect(codexAdapter.parseLine('null')).toBeNull();
    expect(codexAdapter.parseLine('[1,2]')).toBeNull();
  });

  it('parses a whole stream, skipping the noise', async () => {
    const stream = Readable.from([
      '{"type":"thread.started"}\n',
      'warning: something on stderr got interleaved\n',
      '{"type":"turn.completed","usage":{}}\n',
    ]);
    const events = await codexAdapter.parseEventStream(stream);
    expect(events.map((e) => e.type)).toEqual(['thread.started', 'turn.completed']);
  });
});

describe('the tool grant reaches the runtime', () => {
  it('gives Codex a read-only sandbox for a read-only grant', () => {
    const command = codexAdapter.buildCommand('do it', { allowedTools: ['Read'], readOnly: true });
    expect(command).toContain('--sandbox');
    expect(command).toContain('read-only');
  });

  it('does not restrict the sandbox when the grant permits changes', () => {
    expect(codexAdapter.buildCommand('do it', { allowedTools: ['Read', 'Edit'], readOnly: false }))
      .not.toContain('--sandbox');
  });

  it('is unchanged when no grant is supplied', () => {
    expect(codexAdapter.buildCommand('do it')).toEqual(codexAdapter.buildCommand('do it', undefined));
  });
});

describe('codexAdapter dispatch options', () => {
  it('maps opts.model to --model', () => {
    const cmd = codexAdapter.buildCommand('do it', undefined, { model: 'gpt-5-mini' });
    expect(cmd[cmd.indexOf('--model') + 1]).toBe('gpt-5-mini');
    expect(cmd.at(-1)).toBe('do it');
  });

  it('ignores maxTurns and systemPrompt (Codex exec has no equivalent flag)', () => {
    const cmd = codexAdapter.buildCommand('do it', undefined, { maxTurns: 3, systemPrompt: 'x' });
    expect(cmd).not.toContain('--max-turns');
    // Not a substring check on the joined command: 'codex' and 'exec' both
    // contain the letter 'x', so `cmd.join(' ').includes('x')` is true even
    // when systemPrompt is correctly dropped. Check for 'x' as its own token.
    expect(cmd).not.toContain('x');
  });

  it('adds no --model when opts is omitted', () => {
    expect(codexAdapter.buildCommand('do it')).not.toContain('--model');
  });
});
