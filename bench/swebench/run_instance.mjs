#!/usr/bin/env node
/** Runs one SWE-bench Verified instance through one arm, end to end, per
 *  docs/benchmarks/PUBLIC-BENCHMARK-PROMPT.md Step 2.
 *
 *  Both arms get: a fresh isolated worktree forked from the instance's
 *  base_commit (bench/lib/isolation.mjs, the same utility the 2026-09-20
 *  internal benchmark proved load-bearing), the problem_statement verbatim
 *  as the task, the same model pin (sonnet — CherryOnTop's execute role is
 *  pinned to it via ORG_MODEL_EXECUTE so routing/tiering cannot silently
 *  substitute a different model, matching the direct arm's --model flag),
 *  the same dollar budget ceiling, and unrestricted tool access (both
 *  arms' default authority is tools:[], which allowedTools() in
 *  src/engines/enforce-tools.ts reads as "unrestricted" — so neither arm
 *  passes --allowedTools).
 *
 *  Direct arm: the operator's personal Claude Code plugins (ponytail,
 *  superpowers, mattpocock-skills — none of which ship with the product,
 *  all of which inject real behavioral instructions, not just tokens) are
 *  disabled via --settings for this invocation only. This is disclosed in
 *  the report; it is not a full --bare (which needs ANTHROPIC_API_KEY,
 *  declined — subscription billing only). Nothing else about the
 *  operator's Claude Code installation is touched.
 *
 *  Usage: node run_instance.mjs <direct|cherryontop> <instance_id> <repetition> <budgetUsd> <outfile.jsonl>
 */
import { execFileSync, execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { materializeGoalWorktree, releaseGoalWorktree } from '../lib/isolation.mjs';

const execFileP = promisify(execFile);

const [, , arm, instanceId, repetitionArg, budgetArg, outfile] = process.argv;
const repetition = Number(repetitionArg);
const budgetUsd = Number(budgetArg);
if (!['direct', 'cherryontop'].includes(arm) || !instanceId || !Number.isFinite(repetition) || !Number.isFinite(budgetUsd) || !outfile) {
  console.error('usage: run_instance.mjs <direct|cherryontop> <instance_id> <repetition> <budgetUsd> <outfile.jsonl>');
  process.exit(2);
}

const REPO_CACHE = join(homedir(), '.swebench-repos');
const PINNED_MODEL = 'claude-sonnet-5';
// Generous circuit breaker, not the real ceiling — money is the ceiling
// (dispatchDirectArm kills on estimated spend; CherryOnTop's own
// ORG_TASK_SPEND_CAP_USD does the same for the cherryontop arm).
const MAX_TURNS_DIRECT = 80;

// Rough Sonnet rates ($/token), for the *live* budget monitor only — never
// the reported cost, which is always the CLI's own authoritative
// total_cost_usd (completed runs) or the last-seen running estimate,
// clearly flagged, for a budget-aborted run.
const RATE = { input: 3e-6, output: 15e-6, cacheWrite: 3.75e-6, cacheRead: 0.3e-6 };

function estimateCost(usage) {
  return (usage.input_tokens ?? 0) * RATE.input
    + (usage.output_tokens ?? 0) * RATE.output
    + (usage.cache_creation_input_tokens ?? 0) * RATE.cacheWrite
    + (usage.cache_read_input_tokens ?? 0) * RATE.cacheRead;
}

function repoDir(repo) {
  return join(REPO_CACHE, repo.replace('/', '_'));
}

const VENV_PYTHON = join(import.meta.dirname, '..', '..', '.swebench', 'bin', 'python3');

async function fetchInstance(id) {
  const { stdout } = await execFileP(VENV_PYTHON, [join(import.meta.dirname, 'fetch_instance.py'), id], {
    maxBuffer: 64 * 1024 * 1024,
    cwd: import.meta.dirname,
  });
  return JSON.parse(stdout);
}

/** Runs `claude --print` directly, streaming stdout so cost can be tracked
 *  and the process killed once it crosses budgetUsd — the doc's "equalise
 *  on dollars, not turns" instruction, applied to the one arm that has no
 *  native spend guard of its own. */
function runDirect(worktreePath, problemStatement) {
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
      problemStatement,
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

/** Runs the cherryontop arm via `org run`, polling to completion the same
 *  way bench/run.mjs and bench/regime-runner.mjs already do. */
async function runCherryOnTop(worktreePath, problemStatement) {
  const env = { ...process.env, ORG_MODEL_EXECUTE: PINNED_MODEL, ORG_TASK_SPEND_CAP_USD: String(budgetUsd) };
  const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', env });
  const startedAt = Date.now();
  const out = sh('org', ['run', problemStatement, '--repo', worktreePath, '--spawn', '--max-children', '3', '--budget', String(budgetUsd)]);
  const id = (out.match(/Root node created: (\S+)/) || [])[1];
  if (!id) return { state: 'UNRUNNABLE', costUsd: 0, note: 'no node id in org run output' };

  const TERMINAL = ['COMPLETE', 'FAILED', 'CANCELLED'];
  let state = '';
  for (let polls = 0; polls < 360 && !TERMINAL.includes(state); polls++) {
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
    costEstimated: false,
  };
}

async function main() {
  const instance = await fetchInstance(instanceId);
  const base = repoDir(instance.repo);
  if (!existsSync(base)) throw new Error(`repo cache missing: ${base} (run the clone step first)`);

  const label = `${arm}:${instanceId}:${repetition}`;
  const worktree = materializeGoalWorktree(base, instance.base_commit, label);
  let outcome;
  try {
    outcome = arm === 'direct'
      ? await runDirect(worktree.path, instance.problem_statement)
      : await runCherryOnTop(worktree.path, instance.problem_statement);

    execFileSync('git', ['add', '-A'], { cwd: worktree.path });
    const patch = execFileSync('git', ['diff', '--cached'], { cwd: worktree.path, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const filesTouched = patch ? new Set([...patch.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1])).size : 0;

    const cliVersion = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim();

    const row = {
      instance_id: instanceId, repo: instance.repo, arm, repetition,
      ...outcome,
      patchBytes: Buffer.byteLength(patch, 'utf8'),
      filesTouched,
      model: PINNED_MODEL,
      cliVersion,
      revision,
      recordedAt: new Date().toISOString(),
    };
    mkdirSync(join(import.meta.dirname, 'results'), { recursive: true });
    mkdirSync(join(import.meta.dirname, 'patches'), { recursive: true });
    appendFileSync(outfile, JSON.stringify(row) + '\n');
    const patchFile = join(import.meta.dirname, 'patches', `${instanceId}.${arm}.${repetition}.patch`);
    appendFileSync(patchFile, patch);
    console.log(JSON.stringify({ instance_id: instanceId, arm, repetition, state: outcome.state, costUsd: outcome.costUsd, turns: outcome.turns, patchBytes: row.patchBytes }));
  } finally {
    releaseGoalWorktree(base, worktree.path);
  }
}

main().catch((err) => {
  console.error(`[${arm}:${instanceId}:${repetition}] failed:`, err);
  process.exit(1);
});
