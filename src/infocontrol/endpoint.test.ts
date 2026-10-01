import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createDb } from '../db/client.js';
import { listEventsForNode } from '../db/queries/events.js';
import { buildHookApp, hookSettings, icEnv, openSession, setAdvertisedHookAddress, settleFinish, SPILL_COMMAND } from './endpoint.js';
import { finishBelief, refetchBeliefs, turnHistory } from './memory.js';
import { extractText } from './shape.js';
import { SPILL_DIR } from './controller.js';

const TEST_DB = './test-infocontrol.db';
afterEach(() => {
  setAdvertisedHookAddress(null);
  for (const suffix of ['', '-journal', '-wal', '-shm']) if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
});

const BIG = Array.from({ length: 2000 }, (_, i) => `line ${String.fromCharCode(97 + (i % 26))}${i} built target_${(i * 31) % 991}`).join('\n');

function open(mode: 'shadow' | 'active' = 'active') {
  const db = createDb(TEST_DB);
  setAdvertisedHookAddress({ host: '172.18.0.1', port: 4277 });
  const s = openSession({
    db, nodeId: 'node-1', taskRootId: 'root-1', role: 'execute', goal: 'fix the build', model: 'haiku',
    confidence: 0.9, taskValueUsd: 5, revision: null, env: { mode, disabled: new Set() },
  })!;
  return { db, s };
}

describe('icEnv', () => {
  it('defaults to shadow and parses ablations', () => {
    expect(icEnv({}).mode).toBe('shadow');
    expect(icEnv({ ORG_IC_MODE: 'ACTIVE', ORG_IC_DISABLE: 'shape, finish,bogus' })).toEqual({ mode: 'active', disabled: new Set(['shape', 'finish']) });
    expect(icEnv({ ORG_IC_MODE: 'nonsense' }).mode).toBe('shadow');
  });
});

describe('openSession', () => {
  it('is null when off or when no listener is reachable: the dispatch runs as baseline', () => {
    const db = createDb(TEST_DB);
    const base = { db, nodeId: 'n', taskRootId: 'r', role: 'execute', goal: 'g', model: 'haiku', confidence: 0.9, taskValueUsd: 1, revision: null };
    setAdvertisedHookAddress({ host: '172.18.0.1', port: 4277 });
    expect(openSession({ ...base, env: { mode: 'off', disabled: new Set() } })).toBeNull();
    setAdvertisedHookAddress(null);
    expect(openSession({ ...base, env: { mode: 'active', disabled: new Set() } })).toBeNull();
  });

  it('gives the runtime http hooks for its own token, and the spill hook only when shaping is live', () => {
    const { s } = open('active');
    const settings = JSON.parse(s.settings);
    const url = settings.hooks.PreToolUse[0].hooks[0].url as string;
    expect(url).toBe(`http://172.18.0.1:4277/ic/hook/${s.token}`);
    expect(settings.hooks.PostToolUse.some((m: { hooks: Array<{ type: string }> }) => m.hooks[0].type === 'command')).toBe(true);
    expect(JSON.parse(JSON.stringify(hookSettings('u', false))).hooks.PostToolUse).toHaveLength(1);
    expect(s.egress).toEqual({ host: '172.18.0.1', port: 4277 });
    s.close();
  });
});

describe('hook listener', () => {
  it('answers an unknown token or a malformed body with the no-op', async () => {
    const app = buildHookApp();
    const unknown = await app.inject({ method: 'POST', url: '/ic/hook/nope', payload: { hook_event_name: 'PostToolUse' } });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toEqual({});
    const { s } = open();
    const malformed = await app.inject({ method: 'POST', url: `/ic/hook/${s.token}`, headers: { 'content-type': 'application/json' }, payload: '"just a string"' });
    expect(malformed.json()).toEqual({});
    s.close();
  });

  it('routes a real hook call to the session, records the decision, and learns on close', async () => {
    const app = buildHookApp();
    const { db, s } = open('active');
    s.observeEvent({ type: 'assistant', payload: { message: { id: 'm', usage: { cache_read_input_tokens: 30_000, output_tokens: 200 } } } });
    const res = await app.inject({
      method: 'POST', url: `/ic/hook/${s.token}`,
      payload: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'make' }, tool_response: { stdout: BIG, stderr: '' } },
    });
    const out = res.json().hookSpecificOutput?.updatedToolOutput as string;
    expect(out).toContain(`${SPILL_DIR}/toolu_1.out`);
    await app.inject({ method: 'POST', url: `/ic/hook/${s.token}`, payload: { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'toolu_2', tool_input: { file_path: `${SPILL_DIR}/toolu_1.out` } } });
    s.close();
    const types = listEventsForNode(db, 'node-1').map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['ic.decision', 'ic.outcome', 'ic.session']));
    const beliefs = refetchBeliefs(db);
    expect([...beliefs.values()].reduce((a, b) => a + b.refetched, 0)).toBe(1);
    expect(turnHistory(db, 'execute').length).toBe(1);
    // A closed session's token is dead.
    const after = await app.inject({ method: 'POST', url: `/ic/hook/${s.token}`, payload: { hook_event_name: 'Stop' } });
    expect(after.json()).toEqual({});
  });

  it('a shadow session never writes refetch beliefs (nothing was elided)', async () => {
    const app = buildHookApp();
    const { db, s } = open('shadow');
    await app.inject({ method: 'POST', url: `/ic/hook/${s.token}`, payload: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 't', tool_input: { command: 'make' }, tool_response: { stdout: BIG } } });
    s.close();
    expect(refetchBeliefs(db).size).toBe(0);
  });
});

describe('finish labels', () => {
  it('records validation\'s verdict only for a node whose last dispatch finished unverified', async () => {
    const app = buildHookApp();
    const { db, s } = open('shadow');
    await app.inject({ method: 'POST', url: `/ic/hook/${s.token}`, payload: { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: {}, tool_response: 'ok' } });
    await app.inject({ method: 'POST', url: `/ic/hook/${s.token}`, payload: { hook_event_name: 'Stop', last_assistant_message: 'done' } });
    s.close();
    settleFinish(db, 'node-1', true);
    settleFinish(db, 'node-1', true); // settled once only
    settleFinish(db, 'other-node', true);
    expect(finishBelief(db)).toEqual({ failed: 1, finished: 1 });
  });
});

describe('spill hook', () => {
  it('writes exactly the text the controller shaped, named by tool_use_id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cto-ic-'));
    const command = SPILL_COMMAND.split(SPILL_DIR).join(dir);
    const cases: unknown[] = [
      { stdout: 'out line\nmore', stderr: 'warn' },
      { type: 'text', text: 'plain text' },
      { filenames: ['a.py', 'b.py'], numFiles: 2 },
    ];
    cases.forEach((response, i) => {
      const payload = JSON.stringify({ tool_use_id: `toolu_${i}`, tool_response: response });
      execSync(command, { input: payload, shell: '/bin/sh' });
      expect(readFileSync(join(dir, `toolu_${i}.out`), 'utf8')).toBe(extractText(response));
    });
  });

  it('never fails the tool: bad input exits cleanly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cto-ic-'));
    expect(() => execSync(SPILL_COMMAND.split(SPILL_DIR).join(dir), { input: 'not json', shell: '/bin/sh' })).not.toThrow();
  });
});
