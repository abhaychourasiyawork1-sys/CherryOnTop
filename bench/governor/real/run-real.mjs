#!/usr/bin/env node
/** One isolated execution of Arm B of the governor benchmark
 *  (bench/governor/PREREGISTRATION.md): the same build, the governor variant
 *  chosen by ORG_GOVERNOR_ABLATION. Derived from bench/context-pilot/run-one.mjs.
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
 *  Usage: node run-real.mjs <runId> <taskId> <arm:H0|H4> <rep> <slot>
 */
import { execFileSync, execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { materializeGoalWorktree, releaseGoalWorktree } from '../../lib/isolation.mjs';

const [, , runId, taskId, arm, repArg, slotArg] = process.argv;
if (!runId || !taskId || !['H0', 'H4', 'h26', 'h26ctl'].includes(arm) || !repArg || !slotArg) {
  console.error('usage: run-real.mjs <runId> <taskId> <H0|H4|h26|h26ctl> <rep> <slot>');
  process.exit(2);
}
const CONFIG = JSON.parse(readFileSync(join(import.meta.dirname, 'config.json'), 'utf8'));
// h26: one arm, the frozen H2.6 configuration (bench/governor/h26/DESIGN.md
// §8). Both experiment arms run in it; the HMAC coin assigns Z at b*.
// `h26ctl` is the H2.5 control of the engineering validation: the same
// governor variant and bench root, the experiment and D2 both off.
// H26_CONFIG names another config (the validation one); default the pilot's.
const H26_CONFIG_PATH = resolve(process.env.H26_CONFIG ?? join(import.meta.dirname, '..', 'h26', 'config.json'));
const H26 = arm.startsWith('h26') ? JSON.parse(readFileSync(H26_CONFIG_PATH, 'utf8')) : null;
const H26_ON = arm === 'h26';
const task = CONFIG.tasks.find((t) => t.id === taskId || t.instance === taskId);
const instanceId = task?.instance ?? taskId; // an id outside the config is a harness smoke
const slot = Number(slotArg);

const BENCH_ROOT = (H26 ? H26.pilot.benchRoot : CONFIG.benchRoot).replace('~', homedir());
// One build for both arms: only the governor variant differs.
const ARM_DIR = resolve(import.meta.dirname, '..', '..', '..');
const RUN_DIR = join(BENCH_ROOT, 'runs', runId);
const REPO_CACHE = join(homedir(), '.swebench-repos');

const CLI = join(ARM_DIR, 'dist', 'cli', 'index.js');
// H2.6 runs on their own ports, so they never collide with an Arm B run.
const PORT_OFFSET = H26 ? 20 : 0;
const DAEMON_PORT = CONFIG.basePorts.daemon + PORT_OFFSET + slot;
const LAYA_PORT = CONFIG.basePorts.laya + PORT_OFFSET + slot;

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
    ORG_DAEMON_NAME: `govreal-${H26 ? 'h26-' : ''}${slot}`,
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
    ORG_GOVERNOR_ABLATION: H26 ? H26.governorVariant : arm,
    ...(H26 ? {
      ORG_TASK_SPEND_CAP_USD: String(H26.perTaskCapUsd),
      ORG_MAX_TURNS_EXECUTE: String(H26.turnBudget.T),
    } : {}),
    ...(H26_ON ? {
      ...H26.turnBudget.env,
      ORG_EXPERIMENT_CONFIG: H26_CONFIG_PATH,
      // One ledger per experiment, shared by every run (DESIGN.md §4).
      ORG_EXPERIMENT_LEDGER: join(BENCH_ROOT, 'ledger.db'),
      // The key stays outside git; the operator points at it.
      ...(process.env.ORG_EXPERIMENT_KEY_FILE ? { ORG_EXPERIMENT_KEY_FILE: process.env.ORG_EXPERIMENT_KEY_FILE } : {}),
      ...(process.env.ORG_EXPERIMENT ? { ORG_EXPERIMENT: process.env.ORG_EXPERIMENT } : {}),
    } : {}),
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
// Off means off: nothing experiment-related leaks in from the operator's shell.
if (!H26_ON) for (const k of ['ORG_EXPERIMENT_CONFIG', 'ORG_EXPERIMENT_KEY_FILE', 'ORG_EXPERIMENT_LEDGER', 'ORG_EXPERIMENT', 'ORG_TURN_RETRY_RESERVATION']) delete env[k];
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
  // H2.6: a per-run repository holding only base_commit and its ancestors.
  // A worktree of the cache would share its refs, and the sandbox mounts the
  // shared git dir, so origin/main (with the upstream fix) would be reachable.
  const worktree = H26 ? isolatedRepo(base, instance.base_commit) : materializeGoalWorktree(base, instance.base_commit, runId);
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
    experiment: H26 ? H26.experimentId : CONFIG.experiment, run_id: runId, task_id: taskId, instance_id: instance.instance_id, arm, rep: Number(repArg), slot,
    commit_sha: armSha, worktree_revision: worktree.revision, base_commit: instance.base_commit,
    model_alias: CONFIG.model.alias, model_note: CONFIG.model.note, effort: CONFIG.effort, credential_kind: 'claude-subscription-oauth',
    env_pins: Object.fromEntries(Object.entries(env).filter(([k]) => /^ORG_(MODEL|TASK|MAX|RESULT|PLAN|LAYA_PORT|DAEMON_PORT|DAEMON_NAME|GOVERNOR|TURN_RETRY|EXPERIMENT)/.test(k))),
    ...times, outcome, changed_files: files, patch_bytes: Buffer.byteLength(patch),
    problem_statement_chars: instance.problem_statement.length,
    host: { node: process.version, claude_host: tryRun('claude', ['--version']) },
    driver_wall_ms: Date.now() - wallStart,
  };
  writeFileSync(join(RUN_DIR, 'meta.json'), JSON.stringify(meta, null, 2));
  if (H26) rmSync(worktree.path, { recursive: true, force: true }); else releaseGoalWorktree(base, worktree.path);
  console.log(JSON.stringify({ runId, arm, taskId, state: outcome.state, files: files.length }));
}

function isolatedRepo(base, revision) {
  const path = join(RUN_DIR, 'repo');
  const g = (...a) => execFileSync('git', a, { cwd: path, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  mkdirSync(path, { recursive: true });
  g('init', '-q');
  g('fetch', '-q', '--no-tags', `file://${base}`, revision);
  g('checkout', '-q', '--detach', revision);
  rmSync(join(path, '.git', 'FETCH_HEAD'), { force: true });
  g('config', 'user.email', 'bench@localhost'); g('config', 'user.name', 'bench');
  return { path, revision: g('rev-parse', 'HEAD').trim() };
}

function tryRun(cmd, args) { try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim(); } catch { return null; } }

main().catch((e) => { log(`FATAL ${e?.stack ?? e}`); process.exit(1); });
