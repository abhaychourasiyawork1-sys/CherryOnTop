/** Live smoke test: the owned runtime against Claude Code on the same tiny
 *  tasks, in identical fresh containers (the runner image), on the API key.
 *
 *  Spending is opt-in and capped, three ways:
 *    --dry-run (default)  no model call. Builds each task's container, proves
 *                         its check fails before and passes after a scripted
 *                         oracle drives the real owned loop + broker to the
 *                         known fix, and prints the exact first request.
 *    --count-tokens       the free count_tokens endpoint: exact prefix size of
 *                         the owned request (needs the key; costs nothing).
 *    --live --budget USD  real runs. Every dispatch gets min(--per-task,
 *                         what is left of --budget) as its hard limit (the
 *                         owned loop's spend limit, Claude Code's
 *                         --max-budget-usd); nothing starts once the budget
 *                         is spent.
 *
 *  Usage:
 *    npx tsx bench/agent-owned/live-smoke.mts [--dry-run]
 *    npx tsx bench/agent-owned/live-smoke.mts --count-tokens
 *    npx tsx bench/agent-owned/live-smoke.mts --live --budget 0.50 [--per-task 0.10]
 *         [--model haiku] [--arms owned,claude-code] [--tasks calc,wc,greet] [--reps 1] [--out dir]
 */
import { execa } from 'execa';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { runAgentSession, systemPromptFor } from '../../src/agent/loop.js';
import { buildRequest } from '../../src/agent/anthropic-model-client.js';
import { AnthropicModelClient } from '../../src/agent/anthropic-model-client.js';
import { fakeMessage, resolveModelId, scriptedModelClient, toolUse, type ModelClient } from '../../src/agent/model-client.js';
import { containerSandbox, workdirSnapshot } from '../../src/agent/sandbox.js';
import { ToolBroker } from '../../src/agent/tools.js';
import { quietState } from '../../src/adapters/anthropic-owned.js';
import { claudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { usageFromEvents } from '../../src/execution/tokens.js';
import type { StructuredEvent } from '../../src/adapters/adapter.js';

const IMAGE = 'cherryontop-runner:local';
const WORKDIR = '/home/node/work';

interface Task {
  name: string;
  goal: string;
  files: Record<string, string>;
  check: string;
  /** The known fix, as owned-loop tool calls: the dry run's oracle. */
  oracle: Array<{ name: string; input: Record<string, unknown> }>;
}

const TASKS: Task[] = [
  {
    name: 'calc',
    goal: 'The tests in test_calc.py fail. Fix the bug in calc.py so that `python3 test_calc.py` passes. Do not change the tests.',
    files: {
      'calc.py': 'def add(a, b):\n    return a - b\n\n\ndef mul(a, b):\n    return a * b\n',
      'test_calc.py': 'from calc import add, mul\n\nassert add(2, 3) == 5, add(2, 3)\nassert mul(2, 3) == 6\nprint("ok")\n',
    },
    check: 'python3 test_calc.py && grep -q "assert add(2, 3) == 5" test_calc.py',
    oracle: [
      { name: 'Read', input: { file_path: 'calc.py' } },
      { name: 'Edit', input: { file_path: 'calc.py', old_string: 'return a - b', new_string: 'return a + b' } },
    ],
  },
  {
    name: 'wc',
    goal: 'Write a Python script wc.py that prints the number of words in input.txt (only the number, nothing else).',
    files: { 'input.txt': 'the quick brown fox\njumps over\nthe lazy dog\n' },
    check: 'test "$(python3 wc.py)" = "9"',
    oracle: [{ name: 'Write', input: { file_path: 'wc.py', content: 'print(len(open("input.txt").read().split()))\n' } }],
  },
  {
    name: 'greet',
    goal: 'A user reports that `python3 -m app` prints a misspelled greeting. Find the cause and fix it so it prints exactly "Hello, world".',
    files: {
      'app/__init__.py': '',
      'app/__main__.py': 'from app.cli import main\n\nmain()\n',
      'app/cli.py': 'from app.words import greeting\n\n\ndef main():\n    print(f"{greeting()}, world")\n',
      'app/words.py': 'def greeting():\n    return "Helo"\n\n\ndef farewell():\n    return "Goodbye"\n',
      'app/util.py': 'def pad(s, n):\n    return s.ljust(n)\n',
    },
    check: 'test "$(python3 -m app)" = "Hello, world"',
    oracle: [
      { name: 'Grep', input: { pattern: 'Helo', path: 'app', output_mode: 'content' } },
      { name: 'Read', input: { file_path: 'app/words.py' } },
      { name: 'Edit', input: { file_path: 'app/words.py', old_string: '"Helo"', new_string: '"Hello"' } },
      { name: 'Bash', input: { command: 'python3 -m app' } },
    ],
  },
];

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const live = flag('live');
const model = opt('model', 'haiku')!;
const arms = opt('arms', 'owned,claude-code')!.split(',');
const tasks = TASKS.filter((t) => opt('tasks', TASKS.map((x) => x.name).join(','))!.split(',').includes(t.name));
const reps = Number(opt('reps', '1'));
const out = opt('out', `bench/agent-owned/results/${new Date().toISOString().replace(/[:.]/g, '-')}`)!;

async function container(task: Task): Promise<string> {
  const name = `owned-smoke-${task.name}-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
  await execa('docker', ['run', '-d', '--rm', '--name', name, '--entrypoint', 'sleep', IMAGE, '3600']);
  await execa('docker', ['exec', name, 'mkdir', '-p', WORKDIR]);
  for (const [file, content] of Object.entries(task.files)) {
    await execa('docker', ['exec', '-i', '-w', WORKDIR, name, 'sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', file], { input: content });
  }
  // A real repository, as a task's work directory usually is.
  await execa('docker', ['exec', '-w', WORKDIR, name, 'sh', '-c', 'git init -q && git -c user.email=b@x -c user.name=bench add -A && git -c user.email=b@x -c user.name=bench commit -qm init']);
  return name;
}

const check = async (name: string, task: Task) => (await execa('docker', ['exec', '-w', WORKDIR, name, 'sh', '-c', task.check], { reject: false })).exitCode === 0;
const remove = (name: string) => execa('docker', ['rm', '-f', name], { reject: false });

async function runOwned(name: string, task: Task, client: ModelClient, limit?: number) {
  const sandbox = containerSandbox({ container: name, workdir: WORKDIR, docker: 'docker' });
  const state = quietState(task.goal, resolveModelId(model), `smoke-${task.name}`);
  const started = Date.now();
  const r = await runAgentSession({
    sessionId: name, goal: task.goal, workdir: WORKDIR, orientation: await workdirSnapshot(sandbox), model, client,
    broker: new ToolBroker({ sandbox, infoControl: state }), state, maxTurns: 20,
    ...(limit !== undefined ? { spendLimitUsd: limit } : {}),
  });
  return { events: r.events, succeeded: r.succeeded, stop: r.stop, usage: r.usage, costUsd: r.costUsd, ms: Date.now() - started };
}

async function runClaudeCode(name: string, task: Task, limit: number) {
  const argv = claudeCodeAdapter.buildCommand(task.goal, undefined, { model, maxTurns: 20 });
  // The baseline harness calls the model itself, so it must hold the key; it
  // gets it for this one exec only (by name, so it is never in an argv), and
  // the container is removed afterwards.
  const goalAt = argv.lastIndexOf(task.goal);
  const withBudget = [...argv.slice(0, goalAt), '--max-budget-usd', limit.toFixed(4), ...argv.slice(goalAt)];
  const started = Date.now();
  const r = await execa('docker', ['exec', '-i', '-w', WORKDIR, '-e', 'IS_SANDBOX=1', '-e', 'ANTHROPIC_API_KEY', name, ...withBudget], { reject: false, input: '' });
  const events = r.stdout.split('\n').map((l) => claudeCodeAdapter.parseLine(l)).filter((e): e is StructuredEvent => e !== null);
  const result = events.filter((e) => e.type === 'result').at(-1)?.payload as { total_cost_usd?: number; is_error?: boolean; subtype?: string } | undefined;
  return { events, succeeded: result?.is_error === false, stop: result?.subtype ?? `exit ${r.exitCode}`, usage: usageFromEvents(events), costUsd: result?.total_cost_usd ?? 0, ms: Date.now() - started, stderr: r.stderr.slice(-2000) };
}

/** The owned client, wrapped so every request is also logged (the receipt of what we sent). */
function loggingClient(inner: ModelClient, log: unknown[]): ModelClient {
  return { createTurn: async (input, signal) => { log.push({ at: Date.now(), messages: input.messages.length, effort: input.effort ?? null }); return inner.createTurn(input, signal); } };
}

async function dryRun() {
  console.log(`DRY RUN — no model calls. Image ${IMAGE}, model ${resolveModelId(model)}.`);
  let ok = true;
  for (const task of tasks) {
    const name = await container(task);
    try {
      const before = await check(name, task);
      const oracle = scriptedModelClient([
        ...task.oracle.map((c, i) => fakeMessage([toolUse(`toolu_oracle_${i}`, c.name, c.input)])),
        fakeMessage('fixed and verified'),
        // Production default: the finish check asks once; the oracle confirms.
        fakeMessage('confirmed: fixed and verified'),
      ]);
      const r = await runOwned(name, task, oracle);
      const after = await check(name, task);
      const toolErrors = r.events.filter((e) => e.type === 'user').flatMap((e) => (e.payload as { message: { content: Array<{ is_error?: boolean }> } }).message.content).filter((b) => b.is_error).length;
      const pass = !before && after && r.succeeded && toolErrors === 0;
      ok &&= pass;
      console.log(`[${task.name}] check before=${before ? 'PASS (task is trivial!)' : 'fail'} after-oracle=${after ? 'pass' : 'FAIL'} loop=${r.stop} toolErrors=${toolErrors} → ${pass ? 'WIRED' : 'BROKEN'}`);
    } finally {
      await remove(name);
    }
  }
  const sample = buildRequest({ model, maxTokens: 64_000, system: systemPromptFor({ workdir: WORKDIR }), tools: new ToolBroker({ sandbox: containerSandbox({ container: 'x', workdir: WORKDIR, docker: 'docker' }) }).definitions, messages: [{ role: 'user', content: tasks[0]?.goal ?? '' }] });
  const bytes = JSON.stringify(sample).length;
  console.log(`First owned request: model=${sample.model} tools=${sample.tools?.length} system=${JSON.stringify(sample.system).length}B total≈${bytes}B (~${Math.round(bytes / 4)} tokens est.), cache_control on system and request, thinking ${JSON.stringify(sample.thinking ?? null)}, effort ${sample.output_config ? JSON.stringify(sample.output_config) : 'not sent'}.`);
  console.log(`API key in this process: ${process.env.ANTHROPIC_API_KEY ? 'set' : 'not set'} (not used in a dry run).`);
  console.log(ok ? 'All tasks wired.' : 'Some tasks are broken — do not run live.');
  process.exitCode = ok ? 0 : 1;
}

async function countTokens() {
  const client = new Anthropic();
  const body = buildRequest({ model, maxTokens: 64_000, system: systemPromptFor({ workdir: WORKDIR }), tools: new ToolBroker({ sandbox: containerSandbox({ container: 'x', workdir: WORKDIR, docker: 'docker' }) }).definitions, messages: [{ role: 'user', content: tasks[0].goal }] });
  const { max_tokens: _m, cache_control: _c, ...countable } = body;
  const counted = await client.messages.countTokens(countable as Anthropic.MessageCountTokensParams);
  console.log(`count_tokens (free): first owned request for "${tasks[0].name}" on ${body.model} = ${counted.input_tokens} input tokens.`);
}

async function liveRun() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  const budget = Number(opt('budget'));
  if (!(budget > 0)) throw new Error('--live needs --budget <usd> (the hard total cap)');
  const perTask = Number(opt('per-task', '0.10'));
  mkdirSync(out, { recursive: true });
  let spent = 0;
  const rows: Array<Record<string, unknown>> = [];
  console.log(`LIVE — budget $${budget.toFixed(2)}, per dispatch ≤ $${perTask.toFixed(2)}, model ${resolveModelId(model)}, arms ${arms.join(',')}, ${tasks.length} tasks × ${reps}.`);
  for (let rep = 0; rep < reps; rep++) {
    for (const task of tasks) {
      for (const arm of arms) {
        const limit = Math.min(perTask, budget - spent);
        if (limit <= 0.005) { console.log(`Budget spent ($${spent.toFixed(4)}); stopping.`); return finish(); }
        const name = await container(task);
        try {
          const requests: unknown[] = [];
          const r = arm === 'owned'
            ? await runOwned(name, task, loggingClient(new AnthropicModelClient(), requests), limit)
            : await runClaudeCode(name, task, limit);
          const passed = await check(name, task);
          spent += r.costUsd;
          const file = path.join(out, `${task.name}.${arm}.r${rep}.jsonl`);
          writeFileSync(file, r.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
          const row = { task: task.name, arm, rep, passed, stop: r.stop, turns: r.usage.numTurns, usage: r.usage, costUsd: r.costUsd, ms: r.ms, events: file };
          rows.push(row);
          console.log(`[${task.name}/${arm}/r${rep}] ${passed ? 'PASS' : 'FAIL'} stop=${r.stop} turns=${r.usage.numTurns} in=${r.usage.inputTokens} cacheR=${r.usage.cacheReadTokens} cacheW=${r.usage.cacheCreationTokens} out=${r.usage.outputTokens} $${r.costUsd.toFixed(4)} ${(r.ms / 1000).toFixed(1)}s | total $${spent.toFixed(4)}`);
          if ('stderr' in r && !r.succeeded && r.stderr) console.log(`  claude stderr: ${String(r.stderr).trim().slice(-300)}`);
        } finally {
          await remove(name);
        }
      }
    }
  }
  return finish();

  function finish() {
    // The Harness Effect's efficiency metrics, per arm: quality per dollar
    // (η$ = Q / C) and task-completions per million tokens (CPM = Q·10⁶ / τ).
    const perArm = Object.fromEntries(arms.map((arm) => {
      const r = rows.filter((x) => x.arm === arm);
      const q = r.length ? r.filter((x) => x.passed).length / r.length : 0;
      const usd = r.reduce((s, x) => s + Number(x.costUsd), 0) / Math.max(1, r.length);
      const tok = r.reduce((s, x) => { const u = x.usage as { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }; return s + u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens; }, 0) / Math.max(1, r.length);
      return [arm, { runs: r.length, quality: q, costPerTaskUsd: usd, tokensPerTask: tok, qualityPerDollar: usd > 0 ? q / usd : null, cpm: tok > 0 ? (q * 1e6) / tok : null }];
    }));
    for (const [arm, m] of Object.entries(perArm)) console.log(`${arm}: Q=${m.quality.toFixed(2)} $/task=${m.costPerTaskUsd.toFixed(4)} tokens/task=${Math.round(m.tokensPerTask)} η$=${m.qualityPerDollar?.toFixed(1) ?? 'n/a'} CPM=${m.cpm?.toFixed(1) ?? 'n/a'}`);
    writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ model: resolveModelId(model), budget, spent, perArm, rows }, null, 2));
    console.log(`Spent $${spent.toFixed(4)} of $${budget.toFixed(2)}. Receipts in ${out}`);
  }
}

if (live) await liveRun();
else if (flag('count-tokens')) await countTokens();
else await dryRun();
