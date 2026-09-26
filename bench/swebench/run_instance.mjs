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
 *  Arms: `direct` (Claude Code alone), `cherryontop` (with System-1 / Laya,
 *  refused unless Laya is ready) and `cherryontop-nolaya` (ORG_SYSTEM1=off),
 *  so the Laya-vs-off pair isolates Laya and off-vs-direct isolates the harness.
 *
 *  A row carries `rateLimited: true` when the subscription refused the run —
 *  a fact about the account, not the arm; the matrix driver discards and
 *  retries those.
 *
 *  Usage: node run_instance.mjs <direct|cherryontop|cherryontop-nolaya|cherryontop-nomap> <instance_id> <repetition> <budgetUsd> <outfile.jsonl>
 */
import { execFileSync, execFile, spawn } from 'node:child_process';
import { appendFileSync, writeFileSync, existsSync, readFileSync, mkdirSync, statSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { materializeGoalWorktree, releaseGoalWorktree } from '../lib/isolation.mjs';

const execFileP = promisify(execFile);

const [, , arm, instanceId, repetitionArg, budgetArg, outfile] = process.argv;
const repetition = Number(repetitionArg);
const budgetUsd = Number(budgetArg);
if (!['direct', 'cherryontop', 'cherryontop-nolaya', 'cherryontop-nomap'].includes(arm) || !instanceId || !Number.isFinite(repetition) || !Number.isFinite(budgetUsd) || !outfile) {
  console.error('usage: run_instance.mjs <direct|cherryontop|cherryontop-nolaya> <instance_id> <repetition> <budgetUsd> <outfile.jsonl>');
  process.exit(2);
}

const REPO_CACHE = join(homedir(), '.swebench-repos');
const PINNED_MODEL = 'claude-sonnet-5';
// Generous circuit breaker, not the real ceiling — money is the ceiling
// (dispatchDirectArm kills on estimated spend; CherryOnTop's own
// ORG_TASK_SPEND_CAP_USD does the same for the cherryontop arm).
const MAX_TURNS_DIRECT = 80;

// Sonnet 5 rates ($/token), for the *live* budget monitor only — never
// the reported cost, which is always the CLI's own authoritative
// total_cost_usd (completed runs) or the last-seen running estimate,
// clearly flagged, for a budget-aborted run. Were Sonnet 4's $3/$15, which
// killed the direct arm at two thirds of its real budget
// (src/execution/pricing.ts has the source).
const RATE = { input: 2e-6, output: 10e-6, cacheWrite: 2.5e-6, cacheRead: 0.2e-6 };

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
    // Without the operator's GitHub login: the sandboxed arm has none, and on
    // seaborn the host arm fetched the already-fixed upstream file with
    // `gh api repos/mwaskom/seaborn/contents/...`, which is looking up the answer.
    const ghHome = mkdtempSync(join(tmpdir(), 'bench-gh-'));
    const child = spawn('claude', args, {
      cwd: worktreePath,
      env: { ...process.env, GH_CONFIG_DIR: ghHome, GH_TOKEN: '', GITHUB_TOKEN: '' },
    });
    let buf = '';
    let runningCost = 0;
    let turns = 0;
    let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0;
    let finalResult = null;
    let killedForBudget = false;
    let rateLimited = false;
    let usageWindow = null;
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
        if (event.type === 'rate_limit_event') {
          usageWindow = windowOf(event.rate_limit_info);
          if (event.rate_limit_info?.status === 'rejected') rateLimited = true;
        }
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
          usageWindow,
          // Per model: the CLI's total includes calls its top-level usage does
          // not (about $1.9 over 18 runs went unexplained without this).
          modelUsage: finalResult.modelUsage ?? null,
          rateLimited: rateLimited || (finalResult.is_error === true && /usage limit|rate limit/i.test(String(finalResult.result ?? ''))),
        });
      } else {
        resolve({
          state: killedForBudget ? 'CANCELLED' : (code === 0 ? 'COMPLETE' : 'FAILED'),
          costUsd: runningCost,
          inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
          turns, dispatches: 1, wallSeconds,
          costEstimated: true,
          usageWindow,
          rateLimited: rateLimited || /usage limit|rate limit/i.test(stderr),
          note: killedForBudget ? `killed: estimated cost exceeded $${budgetUsd}` : (stderr.slice(0, 500) || undefined),
        });
      }
    });
  });
}

const DAEMON_URL = `http://127.0.0.1:${process.env.ORG_DAEMON_PORT ?? 4177}/trpc/daemon.ping`;

async function ping() {
  try {
    const res = await fetch(DAEMON_URL, { signal: AbortSignal.timeout(2_000) });
    return (await res.json()).result?.data ?? null;
  } catch {
    return null;
  }
}

/** Mirrors orgEnvDigest in src/daemon/manager.ts; keep the two identical. */
function orgEnvDigest(env) {
  const entries = Object.entries(env)
    .filter(([name, value]) => name.startsWith('ORG_') && value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16);
}

/** The host interpreter's install prefix, which the direct arm's `python3`
 *  resolves to: lent read-only to the sandbox so both arms test against the
 *  same packages. Overridable, and skipped outside $HOME (not mountable). */
function hostToolchain() {
  if (process.env.BENCH_SANDBOX_TOOLCHAIN !== undefined) return process.env.BENCH_SANDBOX_TOOLCHAIN;
  try {
    const prefix = execFileSync('python3', ['-c', 'import sys; print(sys.prefix)'], { encoding: 'utf8' }).trim();
    return prefix.startsWith(homedir() + '/') ? prefix : '';
  } catch {
    return '';
  }
}

/** A running daemon keeps the environment it was started with, so the
 *  settings below never reached it when passed to `org run` alone. Restarts it
 *  when its ORG_* settings differ, then refuses to run without System-1 unless
 *  the arm asked for it off: a whole comparison labelled "+ Laya" once measured
 *  no Laya because laya-serve was missing from the daemon's PATH. */
async function prepareDaemon(env, sh) {
  const current = await ping();
  // A daemon started before the last build still runs the old code: a
  // benchmark of "the fix" would silently measure the code before it.
  const builtAt = statSync(join(import.meta.dirname, '..', '..', 'dist', 'server', 'daemon-entry.js')).mtimeMs;
  if (!current || current.envDigest !== orgEnvDigest(env) || !(current.startedAt > builtAt)) {
    if (current) {
      // A restart kills whatever the daemon is running; refuse rather than
      // strand someone's task to change a benchmark's settings.
      const sandboxes = await fetch(DAEMON_URL.replace('daemon.ping', 'daemon.sandboxes')).then((r) => r.json()).then((j) => j.result?.data).catch(() => null);
      if (sandboxes && sandboxes.active + sandboxes.queued > 0) {
        throw new Error(`the daemon needs a restart for this run's ORG_* settings but has ${sandboxes.active} sandbox(es) running and ${sandboxes.queued} queued; wait for them to finish`);
      }
      sh('org', ['daemon', 'stop']);
    }
    sh('org', ['daemon', 'start']);
  }
  const wantsSystem1 = (env.ORG_SYSTEM1 ?? 'laya').toLowerCase() !== 'off';
  const deadline = Date.now() + 300_000;
  for (;;) {
    const p = await ping();
    if (p && p.envDigest !== orgEnvDigest(env)) throw new Error('daemon is running with different ORG_* settings than this run (restart did not take)');
    if (p && (!wantsSystem1 || p.system1?.ready)) return p.system1 ?? { mode: 'unknown', ready: false };
    if (Date.now() > deadline) {
      throw new Error(wantsSystem1
        ? 'System-1 is not ready in the daemon after 5 minutes (is laya-serve installed? see `org doctor`). Set ORG_SYSTEM1=off to measure CherryOnTop without Laya on purpose.'
        : 'daemon did not answer');
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

/** Runs the cherryontop arm via `org run`, polling to completion the same
 *  way bench/run.mjs and bench/regime-runner.mjs already do. */
async function runCherryOnTop(worktreePath, problemStatement, withLaya, withRepoMap = true) {
  const env = {
    ...process.env,
    ORG_SYSTEM1: withLaya ? (process.env.ORG_SYSTEM1 && process.env.ORG_SYSTEM1 !== 'off' ? process.env.ORG_SYSTEM1 : 'laya') : 'off',
    ORG_MODEL_EXECUTE: PINNED_MODEL,
    ORG_TASK_SPEND_CAP_USD: String(budgetUsd),
    // The same turn allowance the direct arm's --max-turns gives it. An
    // explicit value is honoured exactly (src/efficiency/policy.ts), where the
    // complexity band alone gave 34-60 and cut off finished fixes.
    ORG_MAX_TURNS_EXECUTE: String(MAX_TURNS_DIRECT),
    // A benchmark rep measures a run, not a replay of an earlier one.
    ORG_RESULT_CACHE_TTL_HOURS: '0',
    ORG_PLAN_CACHE_TTL_HOURS: '0',
    ORG_SANDBOX_TOOLCHAIN: hostToolchain(),
    // `cherryontop-nomap`: the same run without the repo map, to measure
    // whether the map pays for the tokens it adds to every turn.
    ...(withRepoMap ? {} : { ORG_REPO_MAP_TOKENS: '0' }),
  };
  const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', env });
  const system1 = await prepareDaemon(env, sh);
  const startedAt = Date.now();
  const out = sh('org', ['run', problemStatement, '--repo', worktreePath, '--spawn', '--max-children', '3', '--budget', String(budgetUsd)]);
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
    system1Mode: system1.mode,
    system1Available: system1.ready === true,
    sandboxToolchain: env.ORG_SANDBOX_TOOLCHAIN || null,
    maxTurns: MAX_TURNS_DIRECT,
    costEstimated: false,
    rateLimited: nodeRateLimited(id),
    // Proof, per row, that System-1 actually answered rather than being
    // configured and silently falling back (the earlier benchmark's failure).
    ...system1Evidence(id),
    usageWindow: treeUsageWindow(id),
  };
}

/** The sandbox's CLI version, from the Dockerfile pin the runner image is
 *  built from. Both arms must run the same one: background-task handling
 *  differs between versions, and the two arms once ran 2.1.261 vs 2.1.280. */
function sandboxCliVersion() {
  const dockerfile = readFileSync(join(import.meta.dirname, '..', '..', 'Dockerfile'), 'utf8');
  return (dockerfile.match(/@anthropic-ai\/claude-code@([\d.]+)/) || [])[1] ?? null;
}

/** An expired subscription token fails every CherryOnTop dispatch before it
 *  starts (the sandbox cannot refresh it), which recorded three $0 "FAILED"
 *  rows that looked like results. Running `claude` on the host refreshes it. */
function assertCredentialsFresh() {
  const file = join(homedir(), '.claude', '.credentials.json');
  if (!existsSync(file)) return; // API-key auth: nothing to expire
  const expiresAt = JSON.parse(readFileSync(file, 'utf8')).claudeAiOauth?.expiresAt;
  if (typeof expiresAt === 'number' && expiresAt - Date.now() < 30 * 60_000) {
    throw new Error(`the Claude login ${expiresAt < Date.now() ? 'has expired' : 'expires within 30 minutes'}; run any \`claude\` command on the host to refresh it, then rerun`);
  }
}

function treeSql(rootId, select) {
  return `WITH RECURSIVE t(id) AS (SELECT '${rootId.replace(/[^\w-]/g, '')}' UNION SELECT n.id FROM nodes n JOIN t ON n.parent_id = t.id) ${select}`;
}

/** The subscription's own account of its windows, from a rate_limit_event:
 *  what the matrix driver logs, and what it waits on once one is refused. */
function windowOf(info) {
  if (!info) return null;
  const w = info.unifiedWindows ?? {};
  return {
    status: info.status ?? null,
    resetsAt: info.resetsAt ?? null,
    fiveHour: w.five_hour?.utilization ?? null, fiveHourResetsAt: w.five_hour?.resetsAt ?? null,
    sevenDay: w.seven_day?.utilization ?? null, sevenDayResetsAt: w.seven_day?.resetsAt ?? null,
  };
}

function treeUsageWindow(rootId) {
  const db = process.env.ORG_DB_PATH ?? join(homedir(), '.org', 'state.db');
  try {
    const out = execFileSync('sqlite3', [db, treeSql(rootId,
      `SELECT payload FROM events WHERE node_id IN (SELECT id FROM t) AND type = 'exec.rate_limit_event' ORDER BY id DESC LIMIT 1;`)], { encoding: 'utf8' }).trim();
    return out ? windowOf(JSON.parse(out).rate_limit_info) : null;
  } catch {
    return null;
  }
}

function system1Evidence(rootId) {
  const db = process.env.ORG_DB_PATH ?? join(homedir(), '.org', 'state.db');
  try {
    const out = execFileSync('sqlite3', ['-separator', ' ', db, treeSql(rootId,
      `SELECT count(*), coalesce(sum(json_extract(payload, '$.fallback') = 1), 0), group_concat(DISTINCT json_extract(payload, '$.surface'))
       FROM events WHERE node_id IN (SELECT id FROM t) AND type = 'system1.judgment';`)], { encoding: 'utf8' }).trim().split(' ');
    return { system1Judgments: Number(out[0]), system1Fallbacks: Number(out[1]), system1Surfaces: out[2] || '' };
  } catch {
    return { system1Judgments: null, system1Fallbacks: null, system1Surfaces: null };
  }
}

/** Whether any node in this run's tree was refused by the subscription.
 *  Read from the daemon's own record; sqlite3 rather than an import, for the
 *  same no-`dist/` reason as the rest of this file. */
function nodeRateLimited(rootId) {
  const db = process.env.ORG_DB_PATH ?? join(homedir(), '.org', 'state.db');
  try {
    const sql = `WITH RECURSIVE t(id) AS (SELECT '${rootId.replace(/[^\w-]/g, '')}' UNION SELECT n.id FROM nodes n JOIN t ON n.parent_id = t.id)
      SELECT count(*) FROM events WHERE node_id IN (SELECT id FROM t) AND type = 'step.outcome' AND payload LIKE '%usage limit is used up%';`;
    return Number(execFileSync('sqlite3', [db, sql], { encoding: 'utf8' }).trim()) > 0;
  } catch {
    return false;
  }
}

async function main() {
  assertCredentialsFresh();
  const hostCli = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
  const sandboxCli = sandboxCliVersion();
  if (!sandboxCli || !hostCli.startsWith(sandboxCli + ' ')) {
    throw new Error(`claude CLI differs between arms: host "${hostCli}", runner image pin "${sandboxCli}". Rebuild the image (scripts/build-runner-image.sh) with the host's version.`);
  }
  const patchFile = join(import.meta.dirname, 'patches', `${instanceId}.${arm}.${repetition}.patch`);
  const priorRow = existsSync(outfile) && readFileSync(outfile, 'utf8').split('\n').some((line) => {
    try { const r = JSON.parse(line); return r.instance_id === instanceId && r.arm === arm && r.repetition === repetition; } catch { return false; }
  });
  if (priorRow || existsSync(patchFile)) {
    throw new Error(`${instanceId} ${arm} rep ${repetition} already recorded (${priorRow ? outfile : patchFile}); use a new repetition number`);
  }
  const instance = await fetchInstance(instanceId);
  const base = repoDir(instance.repo);
  if (!existsSync(base)) throw new Error(`repo cache missing: ${base} (run the clone step first)`);

  const label = `${arm}:${instanceId}:${repetition}`;
  const worktree = materializeGoalWorktree(base, instance.base_commit, label);
  let outcome;
  try {
    outcome = arm === 'direct'
      ? await runDirect(worktree.path, instance.problem_statement)
      : await runCherryOnTop(worktree.path, instance.problem_statement, arm !== 'cherryontop-nolaya', arm !== 'cherryontop-nomap');

    execFileSync('git', ['add', '-A'], { cwd: worktree.path });
    const patch = execFileSync('git', ['diff', '--cached'], { cwd: worktree.path, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const filesTouched = patch ? new Set([...patch.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1])).size : 0;

    const cliVersion = arm === 'direct' ? hostCli : `${sandboxCli} (runner image)`;
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
    // Written, never appended: appending glued an older run's patch in front
    // of this one in 8 of 24 files.
    writeFileSync(patchFile, patch);
    console.log(JSON.stringify({ instance_id: instanceId, arm, repetition, state: outcome.state, costUsd: outcome.costUsd, turns: outcome.turns, patchBytes: row.patchBytes }));
  } finally {
    releaseGoalWorktree(base, worktree.path);
  }
}

main().catch((err) => {
  console.error(`[${arm}:${instanceId}:${repetition}] failed:`, err);
  process.exit(1);
});
