#!/usr/bin/env node
/** One isolated execution of the Context Runtime real pilot
 *  (docs/benchmarks/2026-10-01-context-runtime-real-pilot.md).
 *
 *  Everything a run needs is made fresh and thrown away with it:
 *    - a git worktree of the SWE-bench repo at the instance's base commit,
 *    - its own SQLite database, daemon (own pm2 name + port) and Laya,
 *    - the arm's own `dist/` (a separate checkout of one commit).
 *  Nothing is shared between runs except the cluster, the runner image and the
 *  account — and the provider's prompt cache, which is part of what is measured.
 *
 *  This script only EXECUTES and PRESERVES. It computes no metric: everything
 *  derived is computed afterwards, from the preserved database, by collect.mjs,
 *  so an analysis mistake can be fixed without paying for the run again.
 *
 *  Usage: node run-one.mjs <runId> <taskId> <arm:baseline|candidate> <rep> <slot>
 */
import { execFileSync, execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { materializeGoalWorktree, releaseGoalWorktree } from '../lib/isolation.mjs';

const [, , runId, taskId, arm, repArg, slotArg] = process.argv;
if (!runId || !taskId || !['baseline', 'candidate'].includes(arm) || !repArg || !slotArg) {
  console.error('usage: run-one.mjs <runId> <taskId> <baseline|candidate> <rep> <slot>');
  process.exit(2);
}
const CONFIG = JSON.parse(readFileSync(join(import.meta.dirname, 'config.json'), 'utf8'));
const task = CONFIG.tasks.find((t) => t.id === taskId || t.instance === taskId);
const instanceId = task?.instance ?? taskId; // an id outside the config is a harness smoke
const slot = Number(slotArg);

const BENCH_ROOT = CONFIG.benchRoot.replace('~', homedir());
const ARM_DIR = join(BENCH_ROOT, arm);
const RUN_DIR = join(BENCH_ROOT, 'runs', runId);
const REPO_CACHE = join(homedir(), '.swebench-repos');
const VENV_PYTHON = resolve(import.meta.dirname, '..', '..', '.swebench', 'bin', 'python3');
const CLI = join(ARM_DIR, 'dist', 'cli', 'index.js');
const DAEMON_PORT = CONFIG.basePorts.daemon + slot;
const LAYA_PORT = CONFIG.basePorts.laya + slot;

if (existsSync(RUN_DIR)) { console.error(`${RUN_DIR} already exists — a run id is used once`); process.exit(2); }
mkdirSync(join(RUN_DIR, 'jobs'), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}\n`; process.stderr.write(line); writeFileSync(join(RUN_DIR, 'driver.log'), line, { flag: 'a' }); };

/** The environment every run gets. Identical across arms but for the paths. */
function runEnv() {
  const m = CONFIG.model.alias;
  return {
    ...process.env,
    ORG_DB_PATH: join(RUN_DIR, 'state.db'),
    ORG_DAEMON_PORT: String(DAEMON_PORT),
    ORG_DAEMON_NAME: `ctxpilot-${slot}`,
    ORG_LAYA_PORT: String(LAYA_PORT),
    // One model for every role, tier and routing outcome: the comparison is of the
    // context runtime, not of what the market would have routed to.
    ORG_MODEL_EXECUTE: m, ORG_MODEL_PLAN: m, ORG_MODEL_SYNTHESIZE: m,
    ORG_MODEL_FAST: m, ORG_MODEL_STANDARD: m, ORG_MODEL_DEEP: m,
    ORG_TASK_SPEND_CAP_USD: String(CONFIG.budgetUsd),
    ORG_MAX_TURNS_EXECUTE: String(CONFIG.maxTurnsExecute),
    // A pilot run measures a run, never a replay of an earlier one.
    ORG_RESULT_CACHE_TTL_HOURS: '0',
    ORG_PLAN_CACHE_TTL_HOURS: '0',
    ORG_SANDBOX_TOOLCHAIN: hostToolchain(),
  };
}

function hostToolchain() {
  if (process.env.BENCH_SANDBOX_TOOLCHAIN !== undefined) return process.env.BENCH_SANDBOX_TOOLCHAIN;
  try {
    const prefix = execFileSync('python3', ['-c', 'import sys; print(sys.prefix)'], { encoding: 'utf8' }).trim();
    return prefix.startsWith(homedir() + '/') ? prefix : '';
  } catch { return ''; }
}

const env = runEnv();
const org = (args, opts = {}) => execFileSync('node', [CLI, ...args], { encoding: 'utf8', env, maxBuffer: 256 * 1024 * 1024, ...opts });
const ping = async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/trpc/daemon.ping`, { signal: AbortSignal.timeout(2000) });
    return (await res.json()).result?.data ?? null;
  } catch { return null; }
};

async function snapshotJobs(stop) {
  // A Job lives 300 s after it finishes (ttlSecondsAfterFinished) and its command
  // IS the prompt: capture each one the first time it is seen.
  const seen = new Set();
  while (!stop.done) {
    await new Promise((resolveP) => {
      execFile('kubectl', ['-n', 'org-exec', 'get', 'jobs', '-o', 'json'], { maxBuffer: 256 * 1024 * 1024 }, (err, stdout) => {
        if (!err) {
          try {
            for (const j of JSON.parse(stdout).items ?? []) {
              const name = j.metadata?.name;
              if (name && !seen.has(name)) {
                seen.add(name);
                writeFileSync(join(RUN_DIR, 'jobs', `${name}.json`), JSON.stringify({ capturedAt: new Date().toISOString(), job: j }));
              }
            }
          } catch { /* next tick */ }
        }
        resolveP();
      });
    });
    await sleep(1500);
  }
}

async function main() {
  const startedAt = new Date();
  const wallStart = Date.now();
  // Same credentials guard as bench/swebench: the sandbox cannot refresh a token.
  const cred = join(homedir(), '.claude', '.credentials.json');
  if (existsSync(cred)) {
    const exp = JSON.parse(readFileSync(cred, 'utf8')).claudeAiOauth?.expiresAt;
    if (typeof exp === 'number' && exp - Date.now() < 30 * 60_000) throw new Error('Claude login expires within 30 minutes: run any `claude` command on the host to refresh it');
  }

  const instanceFile = join(BENCH_ROOT, 'instances', `${instanceId}.json`);
  if (!existsSync(instanceFile)) throw new Error(`instance cache missing: ${instanceFile} (scheduler fetches it)`);
  const instance = JSON.parse(readFileSync(instanceFile, 'utf8'));
  const base = join(REPO_CACHE, instance.repo.replace('/', '_'));
  const worktree = materializeGoalWorktree(base, instance.base_commit, runId);
  log(`worktree ${worktree.path} @ ${worktree.revision}`);

  const armSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ARM_DIR, encoding: 'utf8' }).trim();
  let outcome = { state: 'UNRUNNABLE' };
  const stopWatch = { done: false };
  let watcher = Promise.resolve();
  const times = { startedAt: startedAt.toISOString() };
  try {
    // Daemon (own pm2 name, own port, own DB, own Laya).
    const d0 = Date.now();
    org(['daemon', 'start']);
    let p = null;
    const deadline = Date.now() + 300_000;
    for (;;) {
      p = await ping();
      if (p?.system1?.ready) break;
      if (Date.now() > deadline) throw new Error(`daemon/System-1 not ready in 5 minutes: ${JSON.stringify(p)}`);
      await sleep(1500);
    }
    times.startupMs = Date.now() - d0;
    times.daemonPing = p;
    log(`daemon ready in ${times.startupMs} ms: ${JSON.stringify({ system1: p.system1, envDigest: p.envDigest })}`);

    watcher = snapshotJobs(stopWatch);

    const submitAt = Date.now();
    times.submittedAt = new Date(submitAt).toISOString();
    const out = org(['run', instance.problem_statement, '--repo', worktree.path, '--spawn', '--max-children', String(CONFIG.maxChildren), '--budget', String(CONFIG.budgetUsd)]);
    writeFileSync(join(RUN_DIR, 'org-run.out'), out);
    const id = (out.match(/Root node created: (\S+)/) || [])[1];
    if (!id) throw new Error(`no node id in org run output: ${out}`);
    log(`root node ${id}`);

    const TERMINAL = ['COMPLETE', 'FAILED', 'CANCELLED'];
    let state = '';
    const limit = Date.now() + CONFIG.timeoutMinutes * 60_000;
    while (!TERMINAL.includes(state) && Date.now() < limit) {
      await sleep(5000);
      try {
        const line = org(['tree']).split('\n').find((l) => l.startsWith(id));
        state = (line || '').trim().split(/\s+/)[1] || '';
      } catch (e) { log(`tree failed: ${String(e).slice(0, 200)}`); }
    }
    if (!TERMINAL.includes(state)) state = 'TIMEOUT';
    times.finishedAt = new Date().toISOString();
    times.wallMs = Date.now() - submitAt;
    // Let trailing events (usage, validation) land before the snapshot.
    await sleep(6000);
    log(`state ${state} after ${times.wallMs} ms`);

    outcome = { state, nodeId: id };
    try { writeFileSync(join(RUN_DIR, 'tokens.json'), org(['tokens', id, '--json', '--economic'])); } catch (e) { log(`tokens failed: ${e}`); }
    try { writeFileSync(join(RUN_DIR, 'tree.txt'), org(['tree'])); } catch { /* informational */ }
  } catch (err) {
    outcome = { ...outcome, state: outcome.state === 'UNRUNNABLE' ? 'UNRUNNABLE' : outcome.state, error: String(err?.stack ?? err) };
    log(`ERROR ${outcome.error}`);
  } finally {
    stopWatch.done = true;
    await watcher;
    try { org(['daemon', 'stop']); } catch (e) { log(`daemon stop: ${String(e).slice(0, 200)}`); }
    await sleep(1500);
    // The supervised Laya's API key lands beside the database: a credential, not evidence.
    try { rmSync(join(RUN_DIR, 'laya.key'), { force: true }); } catch { /* absent */ }
  }

  // Patch + final git state: what the run actually left in the repository.
  let patch = '', status = '';
  try {
    status = execFileSync('git', ['status', '--porcelain'], { cwd: worktree.path, encoding: 'utf8' });
    execFileSync('git', ['add', '-A'], { cwd: worktree.path });
    patch = execFileSync('git', ['diff', '--cached'], { cwd: worktree.path, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch (e) { log(`git capture failed: ${e}`); }
  writeFileSync(join(RUN_DIR, 'model.patch'), patch);
  writeFileSync(join(RUN_DIR, 'git-status.txt'), status);
  const files = [...patch.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]);

  const meta = {
    experiment: CONFIG.experiment, run_id: runId, task_id: taskId, instance_id: instance.instance_id, arm, rep: Number(repArg), slot,
    commit_sha: armSha, worktree_revision: worktree.revision, base_commit: instance.base_commit,
    model_alias: CONFIG.model.alias, model_note: CONFIG.model.note, effort: CONFIG.effort, credential_kind: 'claude-subscription-oauth',
    env_pins: Object.fromEntries(Object.entries(env).filter(([k]) => /^ORG_(MODEL|TASK|MAX|RESULT|PLAN|LAYA_PORT|DAEMON_PORT|DAEMON_NAME)/.test(k))),
    ...times, outcome, changed_files: files, patch_bytes: Buffer.byteLength(patch),
    problem_statement_chars: instance.problem_statement.length,
    host: { node: process.version, claude_host: tryRun('claude', ['--version']) },
    driver_wall_ms: Date.now() - wallStart,
  };
  writeFileSync(join(RUN_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
  releaseGoalWorktree(base, worktree.path);
  console.log(JSON.stringify({ runId, arm, taskId, state: outcome.state, files: files.length }));
}

function tryRun(cmd, args) { try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim(); } catch { return null; } }

main().catch((e) => { log(`FATAL ${e?.stack ?? e}`); process.exit(1); });
