import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAgentSession, systemPromptFor, DEFAULT_MAX_TURNS, CONFIRM_FINISH, RESUME_NOTE, WEB_SEARCH_USD, HARNESS_POLICY, SUMMARY_MODEL, type AgentSessionInput, type SessionState } from './loop.js';
import { SUMMARY_INSTRUCTIONS, MOVED_MARK } from './compaction.js';
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
    broker: new ToolBroker({ sandbox: hostSandbox(dir), infoControl: state }), state,
    // Focused tests: the finish check and web search have their own tests below.
    confirmFinish: false, webSearch: false, microCompaction: false, semanticCompaction: false, ...over,
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
    const results = (client.requests[1].messages[2].content as Array<{ type: string; tool_use_id: string; is_error?: boolean }>).filter((b) => b.type === 'tool_result');
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

describe('paper mechanisms in the loop', () => {
  it('re-tries a turn lost to the network, with a receipt, and gives up after its budget', async () => {
    const ok = await session([new ModelError('network', 'reset'), new ModelError('overloaded', '529'), fakeMessage('done')], { retryDelaysMs: [0, 0] }).run();
    expect(ok.succeeded).toBe(true);
    expect(ok.events.filter((e) => e.type === 'owned.retry').map((e) => (e.payload as { kind: string }).kind)).toEqual(['network', 'overloaded']);
    const out = await session([new ModelError('network', 'a'), new ModelError('network', 'b')], { retryDelaysMs: [0] }).run();
    expect(out).toMatchObject({ stop: 'model_error' });
    const never = await session([new ModelError('auth', 'bad key')], { retryDelaysMs: [0, 0] }).run();
    expect(never.events.some((e) => e.type === 'owned.retry')).toBe(false);
  });

  it('caps a dispatch with no turn limit at the default ceiling', async () => {
    const loop = () => fakeMessage([toolUse(String(Math.random()), 'Bash', { command: 'true' })]);
    const r = await session(Array.from({ length: DEFAULT_MAX_TURNS + 5 }, () => loop)).run();
    expect(r).toMatchObject({ stop: 'max_turns' });
    expect(r.usage.numTurns).toBe(DEFAULT_MAX_TURNS);
  });

  it('recites the task state after a round that changed it, append-only and only once per change', async () => {
    const { run, client } = session([
      fakeMessage([toolUse('r', 'Read', { file_path: 'app.py' })]),
      fakeMessage([toolUse('e', 'Edit', { file_path: 'app.py', old_string: 'x = 1', new_string: 'x = 2' })]),
      fakeMessage([toolUse('g', 'Grep', { pattern: 'x' })]),
      fakeMessage('done'),
    ]);
    await run();
    const texts = (m: MessageParam) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text) : []);
    const final = client.requests[3].messages;
    expect(texts(final[2])).toEqual([]);
    expect(texts(final[4])[0]).toMatch(/^\[CherryOnTop: task state\]\nFiles you have edited \(1\): app\.py/);
    expect(texts(final[4])[0]).not.toContain('Goal:');
    // Unchanged by the Grep: not recited again.
    expect(texts(final[6])).toEqual([]);
    const quiet = session([fakeMessage([toolUse('r', 'Read', { file_path: 'app.py' })]), fakeMessage([toolUse('e', 'Edit', { file_path: 'app.py', old_string: 'x = 1', new_string: 'x = 3' })]), fakeMessage('ok')], { recite: false });
    await quiet.run();
    expect(JSON.stringify(quiet.client.requests[2].messages)).not.toContain('task state');
  });
});

describe('cost', () => {
  it('prices 1-hour cache writes at 2x input, from the API\'s own split', async () => {
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 400, ephemeral_5m_input_tokens: 600 } };
    const r = await session([fakeMessage('done', { usage: usage as never })]).run();
    // Haiku: 600 x 1.25 + 400 x 2.0 = 1550 input-token equivalents at $1/M.
    expect(r.costUsd).toBeCloseTo(1550 / 1e6, 9);
    expect((r.events.at(-1)!.payload as { total_cost_usd: number }).total_cost_usd).toBeCloseTo(1550 / 1e6, 9);
  });
});

describe('Claude Code parity in the loop', () => {
  it('asks once whether a turn without a tool call is really the end, then accepts it', async () => {
    const { run, client } = session([
      fakeMessage('Let me check if there is a /tests directory:'),
      fakeMessage([toolUse('l', 'Bash', { command: 'ls' })]),
      fakeMessage('All done.'),
      fakeMessage('Still done.'),
    ], { confirmFinish: true });
    const r = await run();
    expect(r.succeeded).toBe(true);
    expect(client.requests[1].messages.at(-1)).toEqual({ role: 'user', content: CONFIRM_FINISH });
    // The second stop is accepted: the check is asked once per dispatch.
    expect(client.requests).toHaveLength(3);
    expect(r.finalText).toBe('All done.');
    expect(r.events.filter((e) => e.type === 'owned.confirm_finish')).toHaveLength(1);
  });

  it('resumes a paused server-tool turn by resending, never with an extra user message', async () => {
    const { run, client } = session([
      fakeMessage([{ type: 'server_tool_use', id: 'srv', name: 'web_search', input: { query: 'x' } } as never], { stopReason: 'pause_turn' }),
      fakeMessage('found it'),
    ]);
    const r = await run();
    expect(r.succeeded).toBe(true);
    const resumed = client.requests[1].messages;
    expect(resumed.at(-1)?.role).toBe('assistant');
    expect(JSON.stringify(resumed)).not.toContain('Continue from where you stopped');
  });

  it('offers web search in the model\'s own version and prices each search', async () => {
    const usage = { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 3 } };
    const haiku = session([fakeMessage('ok', { usage: usage as never })], { webSearch: true });
    const r = await haiku.run();
    expect(haiku.client.requests[0].tools.find((t) => 'type' in t && String(t.type).startsWith('web_search'))).toMatchObject({ type: 'web_search_20250305', name: 'web_search' });
    expect(r.costUsd).toBeCloseTo(3 * WEB_SEARCH_USD, 9);
    const sonnet = session([fakeMessage('ok')], { webSearch: true, model: 'sonnet' });
    await sonnet.run();
    expect(sonnet.client.requests[0].tools.some((t) => 'type' in t && t.type === 'web_search_20260209')).toBe(true);
    const readOnly = session([fakeMessage('ok')], { webSearch: true, broker: new ToolBroker({ sandbox: hostSandbox(dir), grant: { allowedTools: ['Read'], readOnly: true } }) });
    await readOnly.run();
    expect(readOnly.client.requests[0].tools.some((t) => 'type' in t && String(t.type).startsWith('web_search'))).toBe(false);
  });

  it('passes the thinking budget through to every turn', async () => {
    const { run, client } = session([fakeMessage('ok')], { thinkingBudget: 8_000 });
    await run();
    expect(client.requests[0].thinkingBudget).toBe(8_000);
  });

  it('charges a sub-agent\'s spend to the dispatch and keeps its trace, marked as the sub-agent\'s', async () => {
    const subUsage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 3 };
    const state = quietState('fix app.py', 'haiku', 'n');
    const broker = new ToolBroker({ sandbox: hostSandbox(dir), infoControl: state, subagent: async () => ({
      text: 'X is in app.py', failed: false, usage: subUsage, costUsd: 1.0,
      events: [{ type: 'assistant', payload: { message: { id: 'm_sub', content: [] } } }, { type: 'result', payload: { total_cost_usd: 1.0 } }],
    }) });
    const { run } = session([fakeMessage([toolUse('t', 'Task', { description: 'look', prompt: 'find X' })]), fakeMessage('done')], { broker, state });
    const r = await run();
    expect(r.usage.inputTokens).toBe(1_000_000 + 200);
    expect(r.costUsd).toBeGreaterThanOrEqual(1.0);
    expect(r.events.find((e) => e.type === 'subagent.result')?.payload).toMatchObject({ parent_tool_use_id: 't' });
    // The dispatch's own result is still the last one: usage and cost readers see the total.
    expect(r.events.at(-1)?.type).toBe('result');
    expect((r.events.at(-1)!.payload as { total_cost_usd: number }).total_cost_usd).toBeCloseTo(r.costUsd, 9);
  });

  it('recites the task list with the state when it changes', async () => {
    const { run, client } = session([
      fakeMessage([toolUse('t', 'TodoWrite', { todos: [{ content: 'reproduce', status: 'in_progress' }, { content: 'fix', status: 'pending' }] })]),
      fakeMessage([toolUse('l', 'Bash', { command: 'ls' })]),
      fakeMessage('done'),
    ], { recite: true });
    await run();
    const texts = (m: MessageParam) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text) : []);
    const final = client.requests[2].messages;
    expect(texts(final[2])[0]).toMatch(/Task list:\n\[~\] reproduce\n\[ \] fix/);
    expect(texts(final[4])).toEqual([]);
  });

  it('opens with the rich harness policy, frozen for every session', async () => {
    const { run, client } = session([fakeMessage('ok')]);
    await run();
    expect(client.requests[0].system.startsWith(HARNESS_POLICY)).toBe(true);
    expect(HARNESS_POLICY).toMatch(/Never end a response by saying what you are about to do/);
  });
});

describe('quality fixes from run 2', () => {
  it('continues a previous attempt\'s conversation, append-only, when nothing in the prefix changed', async () => {
    const first = session([fakeMessage([toolUse('a', 'Bash', { command: 'echo first' })]), fakeMessage('first attempt done')]);
    const r1 = await first.run();
    expect(r1.transcript.messages.at(-1)?.role).toBe('assistant');
    const second = session([fakeMessage('second attempt done')], { resume: r1.transcript });
    const r2 = await second.run();
    const sent = second.client.requests[0].messages;
    expect(JSON.stringify(sent.slice(0, r1.transcript.messages.length))).toBe(JSON.stringify(r1.transcript.messages));
    expect(String(sent.at(-1)!.content)).toContain(RESUME_NOTE);
    expect(r2.events.find((e) => e.type === 'owned.resume')?.payload).toMatchObject({ resumed: true });
  });

  it('starts clean when the model, system prompt or tools differ, and says why', async () => {
    const r1 = await session([fakeMessage('done')]).run();
    const other = session([fakeMessage('ok')], { resume: r1.transcript, systemPrompt: 'a different role' });
    const r2 = await other.run();
    expect(other.client.requests[0].messages).toHaveLength(1);
    expect(r2.events.find((e) => e.type === 'owned.resume')?.payload).toMatchObject({ resumed: false });
  });

  it('does not compact on price unless asked: only the window forces it', async () => {
    const heavy = { input_tokens: 60_000, output_tokens: 10 };
    const turns = Array.from({ length: 12 }, (_, i) => fakeMessage([toolUse(`t${i}`, 'Bash', { command: `echo ${i}` })], { usage: heavy }));
    const r = await session([...turns, fakeMessage('done')]).run();
    expect(r.compactions).toBe(0);
  });

  it('audits the work against the task\'s own requirements before a run may end', () => {
    expect(CONFIRM_FINISH).toMatch(/List every explicit requirement/);
    expect(CONFIRM_FINISH).toMatch(/the way the task's user or tests would call it/);
  });
});

describe('ToFu three-layer compaction in the loop', () => {
  it('layer 2: moves cold bulky outputs behind placeholders that point at a saved file, when it pays', async () => {
    writeFileSync(path.join(dir, 'big.txt'), 'line of data\n'.repeat(4000));
    const turns = [
      ...Array.from({ length: 8 }, (_, i) => fakeMessage([toolUse(`t${i}`, 'Bash', { command: `cat big.txt; echo ${i}` })], { usage: { input_tokens: 2_000 + i * 12_000, output_tokens: 50 } })),
      fakeMessage('done'),
    ];
    // A long task: past dispatches of this role ran ~80 turns, so the outputs
    // would be carried a long way. The same session with no history (expected
    // remaining turns ~ turns so far) does not pay, and nothing moves.
    const short = await session(turns.map((t) => t), { microCompaction: true }).run();
    expect(short.events.some((e) => e.type === 'owned.micro_compaction')).toBe(false);
    const { run, client } = session(turns, { microCompaction: true, pastTurns: Array(30).fill(80) });
    const r = await run();
    const micro = r.events.filter((e) => e.type === 'owned.micro_compaction');
    expect(micro.length).toBeGreaterThan(0);
    expect(micro[0].payload).toMatchObject({ worth: true });
    const last = JSON.stringify(client.requests.at(-1)!.messages);
    expect(last).toContain(MOVED_MARK);
    const saved = /saved at (\/tmp\/cto-ic\/[\w-]+\.out)/.exec(last)?.[1];
    expect(saved).toBeDefined();
    expect(readFileSync(saved!, 'utf8')).toContain('line of data');
    // Every call is still in the conversation.
    expect((last.match(/"tool_use"/g) ?? []).length).toBe(8);
  });

  it('layer 3: near the limit, a lightweight model summarizes the dropped turns into the compacted context', async () => {
    const near = { input_tokens: 120_000, output_tokens: 10 }; // > 80% of Haiku's usable 136k with what follows
    const { run, client } = session([
      fakeMessage([toolUse('a', 'Bash', { command: 'echo one' })], { usage: near }),
      fakeMessage([toolUse('b', 'Bash', { command: 'echo two' })], { usage: near }),
      fakeMessage('Progress so far: echoed one. Key facts: value=42.', { usage: { input_tokens: 3_000, output_tokens: 200 } }),
      fakeMessage('done'),
    ], { semanticCompaction: true });
    const r = await run();
    const summaryReq = client.requests[2];
    expect(summaryReq.model).toBe(SUMMARY_MODEL);
    expect(summaryReq.system).toBe(SUMMARY_INSTRUCTIONS);
    expect(summaryReq.tools).toEqual([]);
    expect(String(client.requests[3].messages[0].content)).toContain('value=42');
    expect(r.events.find((e) => e.type === 'owned.compaction')?.payload).toMatchObject({ reason: 'semantic', summarized: true });
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it('layer 3 falls back to the deterministic compaction when the summarizer fails', async () => {
    const near = { input_tokens: 120_000, output_tokens: 10 };
    const { run, client } = session([
      fakeMessage([toolUse('a', 'Bash', { command: 'echo one' })], { usage: near }),
      fakeMessage([toolUse('b', 'Bash', { command: 'echo two' })], { usage: near }),
      new ModelError('overloaded', 'busy'),
      fakeMessage('done'),
    ], { semanticCompaction: true });
    const r = await run();
    expect(r.succeeded).toBe(true);
    expect(r.events.find((e) => e.type === 'owned.summary')?.payload).toMatchObject({ ok: false });
    expect(r.events.find((e) => e.type === 'owned.compaction')?.payload).toMatchObject({ summarized: false });
    expect(String(client.requests[3].messages[0].content)).toContain('1. Bash echo one');
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

  it('on an adaptive model, strips thinking from the retained exchange (preserved-thinking safe), never from an uncompacted history', async () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'sig' } as never;
    const big = { input_tokens: 990_000, output_tokens: 10 };
    const { run, client } = session([
      fakeMessage([thinking, toolUse('1', 'Bash', { command: 'echo one' })], { usage: big }),
      fakeMessage([thinking, toolUse('2', 'Bash', { command: 'echo two' })], { usage: big }),
      fakeMessage('done'),
    ], { pricedCompaction: false, model: 'sonnet' });
    await run();
    expect(client.requests[1].messages[1].content).toContainEqual(thinking);
    expect(JSON.stringify(client.requests[2].messages)).not.toContain('"thinking"');
  });

  it('on Haiku (budget thinking), keeps thinking on the retained tool round, which the API requires', async () => {
    const thinking = { type: 'thinking', thinking: 'plan', signature: 'sig' } as never;
    const big = { input_tokens: 150_000, output_tokens: 10 };
    const { run, client } = session([
      fakeMessage([thinking, toolUse('1', 'Bash', { command: 'echo one' })], { usage: big }),
      fakeMessage([thinking, toolUse('2', 'Bash', { command: 'echo two' })], { usage: big }),
      fakeMessage('done'),
    ], { pricedCompaction: false });
    const r = await run();
    expect(r.compactions).toBe(1);
    const sent = client.requests[2].messages;
    expect(sent).toHaveLength(3);
    expect((sent[1].content as Array<{ type: string }>)[0].type).toBe('thinking');
  });
});
