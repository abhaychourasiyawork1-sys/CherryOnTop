#!/usr/bin/env node
/** End-to-end check of the anthropic-owned runtime through the real daemon,
 *  with no model spend: the Anthropic SDK is pointed (ANTHROPIC_BASE_URL) at a
 *  local, scripted Messages API that streams real SSE. Everything else is the
 *  production path: `org daemon start`, `org run`, the node machine, the
 *  Action Market, executeStep → the owned adapter → the loop → the broker →
 *  `docker exec` into a task container, in-process information control,
 *  usage rows, validation.
 *
 *  Usage: npm run build && node bench/agent-owned/daemon-e2e.mjs [--keep]
 */
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const CLI = path.join(ROOT, 'dist/cli/index.js');
const IMAGE = 'cherryontop-runner:local';
const WORKDIR = '/home/node/work';
const PORT = 4730 + Math.floor(Math.random() * 100);
const FAKE_KEY = 'sk-ant-fake-e2e-not-a-real-key';
const keep = process.argv.includes('--keep');

const GOAL = 'The tests in test_calc.py fail. Fix the bug in calc.py so that `python3 test_calc.py` passes. Do not change the tests.';
const FILES = {
  'calc.py': 'def add(a, b):\n    return a - b\n',
  'test_calc.py': 'from calc import add\n\nassert add(2, 3) == 5, add(2, 3)\nprint("ok")\n',
};
/** The scripted agent: one step per assistant turn already in the conversation. */
const SCRIPT = [
  { tool: 'Read', input: { file_path: 'calc.py' } },
  { tool: 'Edit', input: { file_path: 'calc.py', old_string: 'return a - b', new_string: 'return a + b' } },
  { tool: 'Bash', input: { command: 'python3 test_calc.py' } },
  { text: 'Fixed add() in calc.py (it subtracted); `python3 test_calc.py` now prints ok.' },
];

// ---------------------------------------------------------------- fake API
const requests = [];
function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': `req_fake_${requests.length}` });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) { res.writeHead(404); res.end('{}'); return; }
    const json = JSON.parse(body);
    requests.push({ headers: { key: req.headers['x-api-key'] ?? null, auth: req.headers.authorization ?? null, beta: req.headers['anthropic-beta'] ?? '' }, body: json });
    const first = typeof json.messages[0]?.content === 'string' ? json.messages[0].content : JSON.stringify(json.messages[0]?.content);
    const ours = first.includes('test_calc.py');
    const done = json.messages.filter((m) => m.role === 'assistant').length;
    const step = ours ? SCRIPT[Math.min(done, SCRIPT.length - 1)] : { text: 'OK' };
    const id = `msg_fake_${requests.length}`;
    const inputTokens = Math.ceil(body.length / 4);
    const block = step.tool
      ? { start: { type: 'tool_use', id: `toolu_fake_${requests.length}`, name: step.tool, input: {} }, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.input) } }
      : { start: { type: 'text', text: '' }, delta: { type: 'text_delta', text: step.text } };
    sse(res, [
      { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: json.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: block.start },
      { type: 'content_block_delta', index: 0, delta: block.delta },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: step.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 40 } },
      { type: 'message_stop' },
    ]);
  });
});

// ---------------------------------------------------------------- helpers
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

// Under $HOME: the CLI refuses a repository the cluster could not mount.
mkdirSync(path.join(homedir(), '.cache'), { recursive: true });
const work = mkdtempSync(path.join(homedir(), '.cache', 'cto-owned-e2e-'));
const state = path.join(work, 'state');
const mirror = path.join(work, 'mirror');
mkdirSync(state); mkdirSync(mirror);
const container = `cto-owned-e2e-${process.pid}`;
const port = 4900 + Math.floor(Math.random() * 300);
const env = {
  ...process.env,
  ORG_DB_PATH: path.join(state, 'state.db'), ORG_DAEMON_PORT: String(port), ORG_DAEMON_NAME: `cto-owned-e2e-${port}`, ORG_LAYA_PORT: String(port + 4000),
  ORG_EXEC_CONTAINER: container, ORG_SANDBOX_WORKDIR: WORKDIR, ORG_EXEC_MIRROR: mirror,
  ORG_RUNTIME: 'anthropic-owned', ANTHROPIC_API_KEY: FAKE_KEY, ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
  ORG_SYSTEM1: 'off', ORG_IC_MODE: 'active', ORG_TASK_SPEND_CAP_USD: '1',
  ORG_RESULT_CACHE_TTL_HOURS: '0', ORG_PLAN_CACHE_TTL_HOURS: '0',
  ...Object.fromEntries(['EXECUTE', 'PLAN', 'SYNTHESIZE', 'FAST', 'STANDARD', 'DEEP'].map((r) => [`ORG_MODEL_${r}`, 'haiku'])),
};
const org = (...args) => {
  const r = spawnSync('node', [CLI, ...args], { env, encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error(`org ${args[0]} failed: ${r.stderr.slice(-800)}`);
  return r.stdout;
};

let daemonStarted = false;
try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  sh('docker', ['run', '-d', '--rm', '--name', container, '--entrypoint', 'sleep', IMAGE, '3600']);
  sh('docker', ['exec', container, 'mkdir', '-p', WORKDIR]);
  for (const [f, c] of Object.entries(FILES)) sh('docker', ['exec', '-i', '-w', WORKDIR, container, 'sh', '-c', 'cat > "$1"', 'sh', f], { input: c });
  for (const [f, c] of Object.entries(FILES)) writeFileSync(path.join(mirror, f), c);
  sh('git', ['init', '-q'], { cwd: mirror });
  sh('git', ['add', '-A'], { cwd: mirror });
  sh('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', 'commit', '-qm', 'start'], { cwd: mirror });

  org('daemon', 'start');
  daemonStarted = true;
  for (let i = 0; ; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/trpc/daemon.ping`); if (r.ok) break; } catch {}
    if (i > 120) throw new Error('daemon did not come up');
    await new Promise((r) => setTimeout(r, 500));
  }
  const out = org('run', GOAL, '--repo', mirror, '--spawn', '--max-children', '1', '--budget', '1');
  const nodeId = out.split('\n').find((l) => l.startsWith('Root node created:'))?.split(/\s+/).at(-1);
  if (!nodeId) throw new Error(`no node id: ${out.slice(-400)}`);
  let status = '';
  for (let i = 0; i < 120 && !['COMPLETE', 'FAILED', 'CANCELLED'].includes(status); i++) {
    await new Promise((r) => setTimeout(r, 2000));
    status = (org('tree').split('\n').find((l) => l.startsWith(nodeId)) ?? '').split(/\s+/)[1] ?? '';
  }
  await new Promise((r) => setTimeout(r, 3000));
  console.log(`node ${nodeId} → ${status}; ${requests.length} model requests served by the fake API\n`);

  // ------------------------------------------------------------ assertions
  const db = new Database(env.ORG_DB_PATH, { readonly: true });
  const events = db.prepare('select type, payload from events where node_id = ? order by id').all(nodeId).map((r) => ({ type: r.type, p: JSON.parse(r.payload) }));
  const types = new Set(events.map((e) => e.type));
  const fixed = spawnSync('docker', ['exec', '-w', WORKDIR, container, 'python3', 'test_calc.py'], { encoding: 'utf8' }).status === 0;
  const ours = requests.filter((r) => JSON.stringify(r.body.messages[0]).includes('test_calc.py'));

  check('task completed', status === 'COMPLETE', status);
  check('the fix landed in the task container', fixed);
  check('every request went to the fake API with the configured key, none with another credential', requests.length > 0 && requests.every((r) => r.headers.key === FAKE_KEY && !r.headers.auth));
  check('requests use the API id and a cached frozen system block',
    ours.every((r) => r.body.model === 'claude-haiku-4-5' && r.body.system?.[0]?.cache_control && r.body.cache_control));
  check('system prompt and tools byte-identical across the dispatch',
    ours.length > 1 && ours.every((r) => JSON.stringify(r.body.system) === JSON.stringify(ours[0].body.system) && JSON.stringify(r.body.tools) === JSON.stringify(ours[0].body.tools)));
  check('history append-only between turns',
    ours.every((r, i) => i === 0 || JSON.stringify(r.body.messages.slice(0, ours[i - 1].body.messages.length)) === JSON.stringify(ours[i - 1].body.messages)));
  const names = (r) => (r.body.tools ?? []).map((t) => t.name ?? t.type);
  check('Haiku thinks on every turn, interleaved between tool calls (budget + beta header)',
    ours.every((r) => r.body.thinking?.type === 'enabled' && r.body.thinking.budget_tokens >= 1024 && r.headers.beta.includes('interleaved-thinking-2025-05-14')), JSON.stringify(ours[0]?.body.thinking));
  check('Claude Code tool parity offered: Bash Read Edit Write Glob Grep WebFetch NotebookEdit TodoWrite Task + server web search',
    ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'NotebookEdit', 'TodoWrite', 'Task', 'web_search'].every((n) => names(ours[0]).includes(n)), names(ours[0] ?? { body: {} }).join(','));
  check('the full harness policy is the frozen system prompt (1h cache)',
    String(ours[0]?.body.system?.[0]?.text).includes('Never end a response by saying what you are about to do') && ours[0]?.body.system?.[0]?.cache_control?.ttl === '1h');
  check('the finish check asked once before the run ended', ours.some((r) => JSON.stringify(r.body.messages.at(-1)).includes('Before you finish')) && types.has('exec.owned.confirm_finish'));
  check('first message carries the work-directory orientation', String(ours[0]?.body.messages[0].content).includes('calc.py') && String(ours[0]?.body.messages[0].content).includes('Contents of the work directory'));
  check('Claude Code–shaped events recorded (init/assistant/user/result)', ['exec.system', 'exec.assistant', 'exec.user', 'exec.result'].every((t) => types.has(t)), [...types].filter((t) => t.startsWith('exec.')).join(','));
  check('per-turn owned receipts recorded', events.filter((e) => e.type === 'exec.owned.turn').length >= SCRIPT.length);
  const usage = JSON.parse(org('tokens', nodeId, '--json')).rows ?? [];
  const exec = usage.filter((u) => u.role === 'execute');
  check('execute usage row recorded with the dispatch\'s tokens and cost', exec.length > 0 && exec.every((u) => u.inputTokens > 0 && u.costUsd > 0), JSON.stringify(exec[0] ?? usage[0] ?? {}).slice(0, 240));
  check('information control ran in-process (ic.session recorded)', types.has('ic.session'));
  const env0 = spawnSync('docker', ['exec', container, 'sh', '-c', 'env | grep -c ANTHROPIC || true'], { encoding: 'utf8' }).stdout.trim();
  check('the task container never received a model credential', env0 === '0');
  const validation = events.filter((e) => e.type === 'validation.result').at(-1)?.p;
  check('validation ran on the owned trace', validation !== undefined, JSON.stringify(validation ?? {}).slice(0, 200));
  db.close();
} catch (err) {
  check('e2e ran', false, err instanceof Error ? err.message : String(err));
} finally {
  if (daemonStarted) spawnSync('node', [CLI, 'daemon', 'stop'], { env, encoding: 'utf8', timeout: 60_000 });
  spawnSync('docker', ['rm', '-f', container]);
  server.close();
  if (!keep) rmSync(work, { recursive: true, force: true }); else console.log(`kept ${work}`);
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
