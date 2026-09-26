#!/usr/bin/env node
/** Runs one Tier B (Terminal-Bench) task through one arm, end to end, per
 *  docs/benchmarks/PUBLIC-BENCHMARK-PROMPT-V2.md §2.2/§3.
 *
 *  Mirrors bench/swebench/run_instance.mjs's architecture: both arms operate
 *  on a fresh materialized worktree (not a docker-orchestrated Harbor
 *  environment -- see bench/tier-b/README.md for why), the direct arm via
 *  `claude --print` on the host, the cherryontop arm via `org run --repo`.
 *  Worktrees must live under this repo (.bench/worktrees) because a kind
 *  cluster's hostPath mount cannot see paths outside it -- the same
 *  constraint bench/lib/isolation.mjs documents for Tier A.
 *
 *  Usage: node run_instance.mjs <direct|cherryontop> <task_id> <repetition> <budgetUsd> <outfile.jsonl>
 *  Prints {..., worktreePath} to stdout so a driver can chain to grade.mjs
 *  before releasing the worktree.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, cpSync, rmSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { system1Totals } from '../metrics/economic.mjs';

const [, , arm, taskId, repetitionArg, budgetArg, outfile] = process.argv;
const repetition = Number(repetitionArg);
const budgetUsd = Number(budgetArg);
if (!['direct', 'cherryontop'].includes(arm) || !taskId || !Number.isFinite(repetition) || !Number.isFinite(budgetUsd) || !outfile) {
  console.error('usage: run_instance.mjs <direct|cherryontop> <task_id> <repetition> <budgetUsd> <outfile.jsonl>');
  process.exit(2);
}

const TASKS = JSON.parse(readFileSync(join(import.meta.dirname, 'tasks.json'), 'utf8'));
const task = TASKS.tasks.find((t) => t.id === taskId);
if (!task) { console.error(`unknown tier-b task: ${taskId}`); process.exit(2); }

const TERMINAL_BENCH_REPO = join(resolve(import.meta.dirname, '..', '..'), '.bench', 'terminal-bench-repo');
const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const WORKTREE_ROOT = join(REPO_ROOT, '.bench', 'worktrees', 'tier-b');

const PINNED_MODEL = 'claude-sonnet-5';
const MAX_TURNS_DIRECT = 120; // long-horizon: higher ceiling than Tier A's 80
// Claude Sonnet 5 list price: $2 / $10 per M tokens; cache write 1.25x, read
// 0.1x. Was Sonnet 4.x's $3 / $15, which overstated spend by 50% and so cut
// the direct arm off at a real ~$3.34 when it read "$5".
const RATE = { input: 2e-6, output: 10e-6, cacheWrite: 2.5e-6, cacheRead: 0.2e-6 };

function estimateCost(usage) {
  return (usage.input_tokens ?? 0) * RATE.input
    + (usage.output_tokens ?? 0) * RATE.output
    + (usage.cache_creation_input_tokens ?? 0) * RATE.cacheWrite
    + (usage.cache_read_input_tokens ?? 0) * RATE.cacheRead;
}

function adaptInstruction() {
  let text = readFileSync(join(TERMINAL_BENCH_REPO, task.repo_dir, 'instruction.md'), 'utf8');
  for (const [from, to] of task.instruction_path_rewrites) text = text.split(from).join(to);
  if (task.instruction_append) text += task.instruction_append;
  return text;
}

function materialize(label) {
  mkdirSync(WORKTREE_ROOT, { recursive: true });
  const path = join(WORKTREE_ROOT, label);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  for (const f of task.env_root_files) {
    cpSync(join(TERMINAL_BENCH_REPO, task.repo_dir, 'environment', f), join(path, f), { recursive: true });
  }
  execFileSync('git', ['init', '-q'], { cwd: path });
  execFileSync('git', ['-c', 'user.email=bench@local', '-c', 'user.name=bench', 'add', '-A'], { cwd: path });
  execFileSync('git', ['-c', 'user.email=bench@local', '-c', 'user.name=bench', 'commit', '-q', '-m', 'baseline', '--allow-empty'], { cwd: path });
  return path;
}

function runDirect(worktreePath, instruction) {
  return new Promise((resolve) => {
    const settings = JSON.stringify({
      enabledPlugins: {
        'ponytail@ponytail': false,
        'superpowers@superpowers-marketplace': false,
        'mattpocock-skills@claude-plugins-official': false,
      },
    });
    const args = [
      '--print', '--output-format', 'stream-json', '--verbose',
      '--model', PINNED_MODEL,
      '--max-turns', String(MAX_TURNS_DIRECT),
      '--settings', settings,
      '--dangerously-skip-permissions',
      instruction,
    ];
    const child = spawn('claude', args, { cwd: worktreePath });
    let buf = '';
    let runningCost = 0;
    let turns = 0;
    let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0;
    let finalResult = null;
    let killedForBudget = false;
    const startedAt = Date.now();

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'assistant' && event.message?.usage) {
          const u = event.message.usage;
          turns += 1;
          inputTokens += u.input_tokens ?? 0;
          outputTokens += u.output_tokens ?? 0;
          cacheReadTokens += u.cache_read_input_tokens ?? 0;
          cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
          runningCost += estimateCost(u);
          if (runningCost > budgetUsd && !killedForBudget) {
            killedForBudget = true;
            child.kill('SIGTERM');
          }
        }
        if (event.type === 'result') finalResult = event;
      }
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });

    child.on('close', (code) => {
      const wallSeconds = Math.round((Date.now() - startedAt) / 1000);
      if (finalResult) {
        resolve({
          state: finalResult.subtype === 'success' ? 'COMPLETE' : 'FAILED',
          costUsd: finalResult.total_cost_usd ?? runningCost,
          inputTokens: finalResult.usage?.input_tokens ?? inputTokens,
          outputTokens: finalResult.usage?.output_tokens ?? outputTokens,
          cacheReadTokens: finalResult.usage?.cache_read_input_tokens ?? cacheReadTokens,
          cacheCreationTokens: finalResult.usage?.cache_creation_input_tokens ?? cacheCreationTokens,
          turns: finalResult.num_turns ?? turns,
          dispatches: 1,
          wallSeconds,
          costEstimated: false,
        });
      } else {
        resolve({
          state: killedForBudget ? 'CANCELLED' : (code === 0 ? 'COMPLETE' : 'FAILED'),
          costUsd: runningCost,
          inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
          turns, dispatches: 1, wallSeconds,
          costEstimated: true,
          note: killedForBudget ? `killed: estimated cost exceeded $${budgetUsd}` : (stderr.slice(0, 500) || undefined),
        });
      }
    });
  });
}

async function runCherryOnTop(worktreePath, instruction) {
  const env = { ...process.env, ORG_MODEL_EXECUTE: PINNED_MODEL, ORG_TASK_SPEND_CAP_USD: String(budgetUsd) };
  const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
  const startedAt = Date.now();
  const out = sh('org', ['run', instruction, '--repo', worktreePath, '--spawn', '--max-children', '3', '--budget', String(budgetUsd)]);
  const id = (out.match(/Root node created: (\S+)/) || [])[1];
  if (!id) return { state: 'UNRUNNABLE', costUsd: 0, note: 'no node id in org run output' };

  const TERMINAL = ['COMPLETE', 'FAILED', 'CANCELLED'];
  let state = '';
  for (let polls = 0; polls < 720 && !TERMINAL.includes(state); polls++) {
    execFileSync('sleep', ['5']);
    const line = sh('org', ['tree']).split('\n').find((l) => l.startsWith(id));
    state = (line || '').trim().split(/\s+/)[1] || '';
  }
  if (!TERMINAL.includes(state)) state = 'TIMEOUT';

  const tokens = JSON.parse(sh('org', ['tokens', id, '--json', '--economic']));
  const sum = (field) => tokens.rows.reduce((acc, r) => acc + (r[field] ?? 0), 0);
  return {
    state, nodeId: id,
    costUsd: Number(sum('costUsd').toFixed(4)),
    inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
    cacheReadTokens: sum('cacheReadTokens'), cacheCreationTokens: sum('cacheCreationTokens'),
    turns: sum('turns'), dispatches: sum('dispatches'),
    wallSeconds: Math.round((Date.now() - startedAt) / 1000),
    models: tokens.rows.map((r) => `${r.role}:${r.model}`).join(' '),
    planCacheHits: tokens.planCacheHits ?? 0, resultCacheHits: tokens.resultCacheHits ?? 0,
    economic: tokens.economic ?? [],
    // Diagnostics that explain this arm's outcome. They are not a second
    // objective: the comparison is the whole harness against Claude Code.
    system1: system1Totals(tokens.economic ?? []),
    costEstimated: false,
  };
}

async function main() {
  const instruction = adaptInstruction();
  const label = `${arm}.${task.id}.${repetition}`;
  const worktree = materialize(label);

  const outcome = arm === 'direct'
    ? await runDirect(worktree, instruction)
    : await runCherryOnTop(worktree, instruction);

  execFileSync('git', ['-c', 'user.email=bench@local', '-c', 'user.name=bench', 'add', '-A'], { cwd: worktree });
  const patch = execFileSync('git', ['diff', '--cached'], { cwd: worktree, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const filesTouched = patch ? new Set([...patch.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1])).size : 0;

  const cliVersion = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();

  const row = {
    tier: 'B', task_id: task.id, task_name: task.task_name, arm, repetition,
    ...outcome,
    patchBytes: Buffer.byteLength(patch, 'utf8'),
    filesTouched,
    model: PINNED_MODEL,
    cliVersion,
    revision,
    worktreePath: worktree,
    recordedAt: new Date().toISOString(),
  };
  mkdirSync(join(import.meta.dirname, 'results'), { recursive: true });
  mkdirSync(join(import.meta.dirname, 'patches'), { recursive: true });
  appendFileSync(outfile, JSON.stringify(row) + '\n');
  const patchFile = join(import.meta.dirname, 'patches', `${task.id}.${arm}.${repetition}.patch`);
  if (patch) writeFileSync(patchFile, patch);
  console.log(JSON.stringify({ task_id: task.id, arm, repetition, state: outcome.state, costUsd: outcome.costUsd, turns: outcome.turns, patchBytes: row.patchBytes, worktreePath: worktree }));
}

main().catch((err) => {
  console.error(`[${arm}:${taskId}:${repetition}] failed:`, err);
  process.exit(1);
});
