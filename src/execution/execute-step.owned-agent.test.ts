import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeStep, type ExecuteStepInput } from './execute-step.js';
import { createOwnedAdapter, sandboxCredentials, anthropicOwnedAdapter } from '../adapters/anthropic-owned.js';
import { claudeCodeAdapter } from '../adapters/claude-code.js';
import { fakeMessage, scriptedModelClient, toolUse, type ScriptedTurn } from '../agent/model-client.js';
import { hostSandbox } from '../agent/sandbox.js';
import { ownedRuntimeSelected } from '../lifecycle/node-actor-manager.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'cto-owned-')); writeFileSync(path.join(dir, 'f.txt'), 'hello\n'); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function input(adapter: ExecuteStepInput['adapter'], over: Partial<ExecuteStepInput> = {}): ExecuteStepInput {
  return { nodeId: 'n1', goal: 'do it', namespace: 'ns', worktreePath: dir, credentials: { ANTHROPIC_API_KEY: 'sk-test', GIT_AUTHOR_NAME: 'me' }, adapter, model: 'haiku', ...over };
}

function owned(turns: ScriptedTurn[], closed: { n: number } = { n: 0 }) {
  return createOwnedAdapter({
    client: () => scriptedModelClient(turns),
    sandbox: async () => ({ ...hostSandbox(dir), close: async () => { closed.n++; } }),
  }, () => true);
}

describe('anthropic-owned through executeStep', () => {
  it('runs the owned loop instead of any Job, with Claude Code–compatible usage and cost', async () => {
    const closed = { n: 0 };
    const events: string[] = [];
    const r = await executeStep(input(owned([
      fakeMessage([toolUse('t', 'Bash', { command: 'cat f.txt' })], { usage: { input_tokens: 1000, output_tokens: 100 } }),
      fakeMessage('done', { usage: { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 10 } }),
      // The production finish check asks once; the model confirms.
      fakeMessage('confirmed done', { usage: { input_tokens: 0, output_tokens: 0 } }),
    ], closed), { onEvent: (e) => events.push(e.type) }), {
      createJob: async () => { throw new Error('no Job may be created'); },
    });
    expect(r).toMatchObject({ succeeded: true, message: 'completed', rateLimited: false });
    expect(r.usage).toEqual({ inputTokens: 1010, outputTokens: 110, cacheReadTokens: 1000, cacheCreationTokens: 0, numTurns: 3 });
    expect((r.events.at(-1)!.payload as { total_cost_usd: number }).total_cost_usd).toBeCloseTo((1010 + 110 * 5 + 1000 * 0.1) / 1e6);
    expect(events).toContain('owned.turn');
    expect(events).toContain('owned.confirm_finish');
    expect(closed.n).toBe(1);
  });

  it('runs a Task sub-agent as a real child loop: same sandbox, no nesting, its spend in the dispatch', async () => {
    const client = scriptedModelClient([
      fakeMessage([toolUse('task1', 'Task', { description: 'look', prompt: 'Report the contents of f.txt' })], { usage: { input_tokens: 100, output_tokens: 10 } }),
      fakeMessage([toolUse('c1', 'Bash', { command: 'cat f.txt' })], { usage: { input_tokens: 50, output_tokens: 5 } }),
      fakeMessage('f.txt says hello', { usage: { input_tokens: 50, output_tokens: 5 } }),
      fakeMessage('f.txt says hello (confirmed)', { usage: { input_tokens: 50, output_tokens: 5 } }),
      fakeMessage('The file says hello.', { usage: { input_tokens: 100, output_tokens: 10 } }),
      fakeMessage('Done.', { usage: { input_tokens: 100, output_tokens: 10 } }),
    ]);
    const adapter = createOwnedAdapter({ client: () => client, sandbox: async () => ({ ...hostSandbox(dir), close: async () => {} }) }, () => true);
    const r = await executeStep(input(adapter, { spendLimitUsd: 1 }));
    expect(r.succeeded).toBe(true);
    const names = (i: number) => client.requests[i].tools.map((t) => ('name' in t ? t.name : ''));
    expect(names(0)).toContain('Task');
    expect(names(1)).not.toContain('Task');
    expect(client.requests[1].messages[0].content).toContain('Report the contents of f.txt');
    const toolResult = client.requests[4].messages.at(-1)!.content as Array<{ type: string; content?: string }>;
    expect(toolResult[0].content).toBe('f.txt says hello (confirmed)');
    expect(r.usage.inputTokens).toBe(450);
    expect(r.events.some((e) => e.type === 'subagent.result' && (e.payload as { parent_tool_use_id?: string }).parent_tool_use_id === 'task1')).toBe(true);
  });

  it('a second dispatch on the same node continues the first one\'s conversation (retry, proof pass)', async () => {
    const client = scriptedModelClient([
      fakeMessage([toolUse('a', 'Bash', { command: 'cat f.txt' })]), fakeMessage('first: done'), fakeMessage('first: confirmed'),
      fakeMessage('second: fixed'), fakeMessage('second: confirmed'),
    ]);
    const adapter = createOwnedAdapter({ client: () => client, sandbox: async () => ({ ...hostSandbox(dir), close: async () => {} }) }, () => true);
    await executeStep(input(adapter, { nodeId: 'resume-node' }));
    const firstLength = client.requests.at(-1)!.messages.length + 1;
    const r = await executeStep(input(adapter, { nodeId: 'resume-node' }));
    expect(r.succeeded).toBe(true);
    expect(client.requests[3].messages.length).toBe(firstLength + 1);
    expect(r.events.find((e) => e.type === 'owned.resume')?.payload).toMatchObject({ resumed: true });
    // Another node never sees it.
    const other = scriptedModelClient([fakeMessage('x'), fakeMessage('y')]);
    await executeStep(input(createOwnedAdapter({ client: () => other, sandbox: async () => ({ ...hostSandbox(dir), close: async () => {} }) }, () => true), { nodeId: 'another-node' }));
    expect(other.requests[0].messages).toHaveLength(1);
  });

  it('a resumed attempt can still fetch the result:// references its conversation holds; FetchResult is never a violation', async () => {
    writeFileSync(path.join(dir, 'big.txt'), Array.from({ length: 3000 }, (_, i) => `row ${i}`).join('\n'));
    const client = scriptedModelClient([
      fakeMessage([toolUse('big', 'Read', { file_path: 'big.txt' })]), fakeMessage('first: done'), fakeMessage('first: confirmed'),
      fakeMessage([toolUse('f', 'FetchResult', { ref: 'result://big', pattern: 'row 2999' })]), fakeMessage('second: done'), fakeMessage('second: confirmed'),
    ]);
    const violations: string[] = [];
    const adapter = createOwnedAdapter({ client: () => client, sandbox: async () => ({ ...hostSandbox(dir), close: async () => {} }) }, () => true);
    const grant = { allowedTools: ['Read'], readOnly: true };
    await executeStep(input(adapter, { nodeId: 'store-node', grant, onViolation: (t) => violations.push(t) }));
    const r = await executeStep(input(adapter, { nodeId: 'store-node', grant, onViolation: (t) => violations.push(t) }));
    expect(r.succeeded).toBe(true);
    const fetched = client.requests[4].messages.at(-1)!.content as Array<{ type: string; content?: string; is_error?: boolean }>;
    expect(fetched[0].is_error).toBeUndefined();
    expect(fetched[0].content).toContain('row 2999');
    expect(violations).toEqual([]);
  });

  it('reports a forbidden request as a violation and never runs it', async () => {
    const violations: string[] = [];
    const r = await executeStep(input(owned([
      fakeMessage([toolUse('t', 'Bash', { command: 'touch bad' })]),
      fakeMessage('ok'),
      fakeMessage('ok, done'),
    ]), { grant: { allowedTools: ['Read'], readOnly: true }, onViolation: (t) => violations.push(t) }));
    expect(violations).toEqual(['Bash']);
    expect(existsSync(path.join(dir, 'bad'))).toBe(false);
    expect(r.succeeded).toBe(true);
  });

  it('fails cleanly, without a sandbox, when no API key is configured', async () => {
    const sandbox = vi.fn();
    const adapter = createOwnedAdapter({ client: () => scriptedModelClient([]), sandbox }, () => false);
    const r = await executeStep(input(adapter));
    expect(r).toMatchObject({ succeeded: false, message: expect.stringMatching(/ANTHROPIC_API_KEY/) });
    expect(sandbox).not.toHaveBeenCalled();
  });

  it('stops a dispatch at its timeout and still closes the sandbox', async () => {
    const closed = { n: 0 };
    const adapter = createOwnedAdapter({
      client: () => ({ createTurn: (_i, signal) => new Promise((_r, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')))) }),
      sandbox: async () => ({ ...hostSandbox(dir), close: async () => { closed.n++; } }),
    }, () => true);
    const r = await executeStep(input(adapter, { timeoutMs: 50 }));
    expect(r).toMatchObject({ succeeded: false, message: expect.stringMatching(/timed out/) });
    expect(closed.n).toBe(1);
  });

  it('keeps model credentials out of the sandbox', () => {
    expect(sandboxCredentials({ ANTHROPIC_API_KEY: 'k', CLAUDE_CREDENTIALS_JSON: '{}', GH_TOKEN: 'g', GIT_AUTHOR_NAME: 'a' })).toEqual({ GH_TOKEN: 'g', GIT_AUTHOR_NAME: 'a' });
  });

  it('describes a dispatch so capability probing sees the model and system prompt survive', () => {
    const argv = anthropicOwnedAdapter.buildCommand('goal', undefined, { model: 'haiku', systemPrompt: 'probe' });
    expect(argv).toContain('haiku');
    expect(argv).toContain('probe');
    expect(anthropicOwnedAdapter.servesModel!('gpt-5')).toBe(false);
  });
});

describe('runtime selection', () => {
  it('is explicit, and falls back to Claude Code without an API key', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(ownedRuntimeSelected({})).toBe(false);
    expect(ownedRuntimeSelected({ ORG_RUNTIME: 'anthropic-owned', ANTHROPIC_API_KEY: 'k' })).toBe(true);
    expect(ownedRuntimeSelected({ ORG_RUNTIME: 'anthropic-owned' })).toBe(false);
    expect(ownedRuntimeSelected({ ORG_RUNTIME: 'claude-code', ANTHROPIC_API_KEY: 'k' })).toBe(false);
    errors.mockRestore();
  });

  it('leaves the Claude Code adapter untouched: no run hook, same argv', () => {
    expect(claudeCodeAdapter.run).toBeUndefined();
    expect(claudeCodeAdapter.buildCommand('g')[0]).toBe('claude');
  });
});
