import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAgentSession, systemPromptFor, type AgentSessionInput, type SessionState } from './loop.js';
import { fakeMessage, scriptedModelClient, toolUse, ModelError, type ScriptedTurn, type MessageParam } from './model-client.js';
import { hostSandbox } from './sandbox.js';
import { ToolBroker } from './tools.js';
import { quietState } from '../adapters/anthropic-owned.js';
import { usageFromEvents, visibleContextProfile } from '../execution/tokens.js';
import { observationsFromEvents } from '../execution/observation.js';
import { toolNamesFromEvent } from '../execution/tool-calls.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cto-loop-'));
  writeFileSync(path.join(dir, 'app.py'), 'x = 1\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function session(turns: ScriptedTurn[], over: Partial<AgentSessionInput> = {}) {
  const client = scriptedModelClient(turns);
  // The broker reports to the same state the loop recites, as the adapter wires it.
  const state = over.state ?? quietState('fix app.py', 'haiku', 'n');
  const input: AgentSessionInput = {
    sessionId: 's', goal: 'fix app.py', workdir: dir, model: 'haiku', client,
    broker: new ToolBroker({ sandbox: hostSandbox(dir), infoControl: state }), state, ...over,
  };
  return { client, run: () => runAgentSession(input) };
}

describe('runAgentSession', () => {
  it('finishes on a text-only answer, with Claude Code–shaped events every reader understands', async () => {
    const { run } = session([fakeMessage('nothing to do', { usage: { input_tokens: 50, output_tokens: 5 } })]);
    const r = await run();
    expect(r).toMatchObject({ stop: 'end_turn', succeeded: true, finalText: 'nothing to do' });
    expect(r.events.map((e) => e.type)).toEqual(['system', 'assistant', 'owned.turn', 'result']);
    expect(usageFromEvents(r.events)).toEqual({ inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 1 });
    expect((r.events.at(-1)!.payload as { total_cost_usd: number }).total_cost_usd).toBeCloseTo((50 * 1 + 5 * 5) / 1e6);
  });

  it('runs one tool call and feeds back its result', async () => {
    const { run, client } = session([
      fakeMessage([toolUse('t1', 'Bash', { command: 'cat app.py' })]),
      fakeMessage('x is 1'),
    ]);
    const r = await run();
    expect(r.succeeded).toBe(true);
    const second = client.requests[1].messages;
    expect(second).toHaveLength(3);
    expect(second[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x = 1' }] });
    // The trace reads as a Claude Code trace: observations pair call and result.
    const obs = observationsFromEvents(r.events, 'n');
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ tool: { name: 'Bash' }, raw: 'x = 1' });
  });

  it('answers parallel calls in one user message, in order, errors included', async () => {
    const { run, client } = session([
      fakeMessage([toolUse('a', 'Read', { file_path: 'app.py' }), toolUse('b', 'Read', { file_path: 'missing' }), toolUse('c', 'Bash', { command: 'echo 2' })]),
      fakeMessage('ok'),
    ]);
    await run();
    const results = client.requests[1].messages[2].content as Array<{ tool_use_id: string; is_error?: boolean }>;
    expect(results.map((b) => b.tool_use_id)).toEqual(['a', 'b', 'c']);
    expect(results.map((b) => b.is_error === true)).toEqual([false, true, false]);
  });

  it('runs sequential tool calls that change the sandbox', async () => {
    const { run } = session([
      fakeMessage([toolUse('r', 'Read', { file_path: 'app.py' })]),
      fakeMessage([toolUse('e', 'Edit', { file_path: 'app.py', old_string: 'x = 1', new_string: 'x = 2' })]),
      fakeMessage([toolUse('v', 'Bash', { command: 'grep -c "x = 2" app.py' })]),
      fakeMessage('changed and checked'),
    ]);
    const r = await run();
    expect(r.usage.numTurns).toBe(4);
    expect(readFileSync(path.join(dir, 'app.py'), 'utf8')).toBe('x = 2\n');
  });

  it('keeps the system prompt and tools byte-identical, and the history append-only, across turns', async () => {
    const { run, client } = session([
      fakeMessage([toolUse('1', 'Bash', { command: 'echo a' })]),
      fakeMessage([toolUse('2', 'Bash', { command: 'echo b' })]),
      fakeMessage('done'),
    ], { pricedCompaction: false });
    await run();
    const [a, b, c] = client.requests;
    expect(b.system).toBe(a.system);
    expect(JSON.stringify(c.tools)).toBe(JSON.stringify(a.tools));
    expect(JSON.stringify(c.messages.slice(0, b.messages.length))).toBe(JSON.stringify(b.messages));
    expect(a.system).toBe(systemPromptFor({ workdir: dir }));
  });

  it('stops at the turn cap and at the spend limit, saying which', async () => {
    const loop = () => fakeMessage([toolUse(String(Math.random()), 'Bash', { command: 'true' })], { usage: { input_tokens: 400_000, output_tokens: 0 } });
    const capped = await session([loop, loop, loop, loop], { maxTurns: 2 }).run();
    expect(capped).toMatchObject({ stop: 'max_turns', succeeded: false });
    expect(capped.usage.numTurns).toBe(2);
    // Haiku input at $1/M: two turns of 400k is $0.80, past a $0.50 limit.
    const spent = await session([loop, loop, loop, loop], { spendLimitUsd: 0.5 }).run();
    expect(spent).toMatchObject({ stop: 'spend_limit', succeeded: false });
    expect(spent.usage.numTurns).toBe(2);
    expect((spent.events.at(-1)!.payload as { result: string }).result).toMatch(/\$0\.50 spend limit/);
  });

  it('turns a model error into a receipt; a rate limit is reported the way health observation reads it', async () => {
    const r = await session([new ModelError('rate_limit', '429')]).run();
    expect(r).toMatchObject({ stop: 'model_error', succeeded: false });
    expect(r.error?.kind).toBe('rate_limit');
    expect(r.events.some((e) => e.type === 'rate_limit_event')).toBe(true);
    expect(r.events.at(-1)).toMatchObject({ type: 'result', payload: { is_error: true, error_kind: 'rate_limit' } });
  });

  it('recovers once from a refused request by rebuilding the context from state', async () => {
    const { run, client } = session([
      fakeMessage([toolUse('1', 'Bash', { command: 'echo a' })]),
      fakeMessage([toolUse('2', 'Bash', { command: 'echo b' })]),
      new ModelError('bad_request', 'prompt is too long'),
      fakeMessage('done'),
    ], { pricedCompaction: false });
    const r = await run();
    expect(r.succeeded).toBe(true);
    expect(r.compactions).toBe(1);
    expect(client.requests[3].messages).toHaveLength(3);
    expect(r.events.find((e) => e.type === 'owned.compaction')?.payload).toMatchObject({ reason: 'recovery', droppedCallIds: ['1'], retainedCallIds: ['2'] });
    const twice = await session([fakeMessage([toolUse('1', 'Bash', { command: 'echo a' })]), new ModelError('bad_request', 'x')]).run();
    expect(twice.stop).toBe('model_error');
  });

  it('never runs a tool call from a turn cut off at max_tokens', async () => {
    const { run, client } = session([
      fakeMessage([toolUse('1', 'Write', { file_path: 'app.py', content: 'trunc' })], { stopReason: 'max_tokens' }),
      fakeMessage('ok'),
    ]);
    await run();
    expect(readFileSync(path.join(dir, 'app.py'), 'utf8')).toBe('x = 1\n');
    expect(client.requests[1].messages[2].content).toMatchObject([{ tool_use_id: '1', is_error: true }]);
  });

  it('stops on a refusal without running its tools', async () => {
    const r = await session([fakeMessage([toolUse('1', 'Bash', { command: 'touch no' })], { stopReason: 'refusal' })]).run();
    expect(r.stop).toBe('refusal');
  });

  it('sends the model back once when the finish gate blocks an unverified finish', async () => {
    let calls = 0;
    const state: SessionState = {
      handle: async (p) => (p.hook_event_name === 'Stop' && calls++ === 0 ? { decision: 'block', reason: 'run a check first' } : {}),
      activeState: () => 'Goal: g', observeEvent: () => {},
    };
    const { run, client } = session([fakeMessage('done?'), fakeMessage('checked, done')], { state });
    const r = await run();
    expect(r.finalText).toBe('checked, done');
    expect(client.requests[1].messages.at(-1)).toEqual({ role: 'user', content: 'run a check first' });
  });

  it('reports what every turn carried, by layer, and the tools\' fate', async () => {
    const { run } = session([
      fakeMessage([toolUse('1', 'Bash', { command: 'echo a' })], { usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 7 } }),
      fakeMessage('done'),
    ]);
    const r = await run();
    const receipts = r.events.filter((e) => e.type === 'owned.turn').map((e) => e.payload as Record<string, unknown>);
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({ turn: 1, model: 'claude-haiku-4-5', compactedBefore: false, tools: [{ id: '1', name: 'Bash', isError: false, projected: false }] });
    expect((receipts[0].layers as { systemTokens: number }).systemTokens).toBeGreaterThan(0);
    expect(visibleContextProfile(r.events).first).toBe(1000);
    expect(r.events.filter((e) => e.type === 'assistant').flatMap(toolNamesFromEvent)).toEqual(['Bash']);
  });
});

describe('orientation', () => {
  it('follows the goal in the first message only, leaving the system prompt identical across tasks', async () => {
    const { run, client } = session([fakeMessage('ok')], { orientation: 'Contents of the work directory: app.py' });
    await run();
    expect(client.requests[0].messages[0].content).toBe('fix app.py\n\nContents of the work directory: app.py');
    expect(client.requests[0].system).toBe(systemPromptFor({ workdir: dir }));
  });
});

describe('compaction in the loop', () => {
  it('compacts when the window forces it, keeping the goal, state, an index of dropped calls and the last exchange', async () => {
    const big = { input_tokens: 150_000, output_tokens: 10 };
    const { run, client } = session([
      fakeMessage([toolUse('1', 'Bash', { command: 'echo one' })], { usage: big }),
      fakeMessage([toolUse('2', 'Bash', { command: 'false' })], { usage: big }),
      fakeMessage('done'),
    ], { pricedCompaction: false });
    const r = await run();
    expect(r.compactions).toBe(1);
    const sent = client.requests[2].messages as MessageParam[];
    expect(sent).toHaveLength(3);
    const head = sent[0].content as string;
    expect(head.startsWith('fix app.py')).toBe(true);
    expect(head).toContain('1. Bash echo one');
    expect(head).toContain('Last failure');
    expect(sent[1]).toMatchObject({ role: 'assistant', content: [{ type: 'tool_use', id: '2' }] });
    const receipt = r.events.filter((e) => e.type === 'owned.turn').at(-1)!.payload as { compactedBefore: boolean };
    expect(receipt.compactedBefore).toBe(true);
  });

  it('strips thinking from the retained exchange (preserved-thinking safe) but never from an uncompacted history', async () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'sig' } as never;
    const big = { input_tokens: 150_000, output_tokens: 10 };
    const { run, client } = session([
      fakeMessage([thinking, toolUse('1', 'Bash', { command: 'echo one' })], { usage: big }),
      fakeMessage([thinking, toolUse('2', 'Bash', { command: 'echo two' })], { usage: big }),
      fakeMessage('done'),
    ], { pricedCompaction: false });
    await run();
    expect(client.requests[1].messages[1].content).toContainEqual(thinking);
    expect(JSON.stringify(client.requests[2].messages)).not.toContain('"thinking"');
  });
});
