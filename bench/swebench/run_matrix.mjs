#!/usr/bin/env node
/** The 6 instances x 3 reps x 3 arms benchmark, end to end and resumable.
 *
 *  Arms: `direct` (Claude Code alone), `cherryontop` (Laya live — the runner
 *  refuses to start without it) and `cherryontop-nolaya` (ORG_SYSTEM1=off).
 *
 *  The results file is the only state. Re-running this script skips every
 *  (instance, arm, rep) already recorded, so a crash, a reboot or a spent
 *  usage window costs nothing but the run in flight. Order is rep-major (all of
 *  rep 1 before rep 2) with the arm order shuffled per cell from a fixed seed,
 *  so a matrix cut short by the weekly limit is still balanced across arms.
 *
 *  A run the subscription refused is a fact about the account, not the arm:
 *  its row and patch are deleted, the script sleeps until the window resets,
 *  and the same run goes again.
 *
 *  When every cell is recorded it grades all nine prediction sets
 *  (grade_matrix.sh) and writes the analysis (analyze_matrix.py).
 *
 *  Usage: node run_matrix.mjs [budgetUsd=3]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..', '..');
const BUDGET = process.argv[2] ?? '3';
// Overridable so a follow-up (e.g. a fix check on two instances) reuses the
// same driver without touching the main matrix's files.
const NAME = process.env.MATRIX_NAME ?? 'matrix';
const OUT = join(HERE, 'results', `${NAME}.jsonl`);
const LOG = join(HERE, 'results', `${NAME}.log`);
const INSTANCES = process.env.MATRIX_INSTANCES ? process.env.MATRIX_INSTANCES.split(',') : [
  'pallets__flask-5014', 'psf__requests-1142', 'mwaskom__seaborn-3187',
  'scikit-learn__scikit-learn-14710', 'sympy__sympy-17139', 'pydata__xarray-6744',
];
const ARMS = process.env.MATRIX_ARMS ? process.env.MATRIX_ARMS.split(',') : ['direct', 'cherryontop', 'cherryontop-nolaya'];
// Offset so these never collide with the patches of earlier benchmarks.
const REPS = process.env.MATRIX_REPS ? process.env.MATRIX_REPS.split(',').map(Number) : [31, 32, 33];

mkdirSync(join(HERE, 'results'), { recursive: true });
const log = (msg) => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  appendFileSync(LOG, line + '\n');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Deterministic shuffle (mulberry32), so a restart reproduces the order. */
function shuffled(items, seed) {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const rows = () => (existsSync(OUT) ? readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const patchFile = (inst, arm, rep) => join(HERE, 'patches', `${inst}.${arm}.${rep}.patch`);
const same = (r, inst, arm, rep) => r.instance_id === inst && r.arm === arm && r.repetition === rep;

/** Removes a refused run so the runner's one-row-per-rep guard lets it go again. */
function discard(inst, arm, rep) {
  const keep = rows().filter((r) => !same(r, inst, arm, rep));
  writeFileSync(OUT, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''));
  if (existsSync(patchFile(inst, arm, rep))) unlinkSync(patchFile(inst, arm, rep));
}

/** Any `claude` command on the host refreshes the subscription token; the
 *  sandbox cannot. Done well before expiry so a long CherryOnTop run never
 *  starts on a token that dies halfway. */
function refreshTokenIfNeeded() {
  const file = join(homedir(), '.claude', '.credentials.json');
  if (!existsSync(file)) return;
  const expiresAt = JSON.parse(readFileSync(file, 'utf8')).claudeAiOauth?.expiresAt ?? Infinity;
  if (expiresAt - Date.now() > 40 * 60_000) return;
  // The CLI only renews a token close to its expiry, so one call made early
  // did nothing and the runner then refused to start (it needs 30 minutes of
  // validity). Keep nudging it, a minute apart, until the token is renewed.
  log('renewing the Claude login token');
  const readExpiry = () => JSON.parse(readFileSync(file, 'utf8')).claudeAiOauth?.expiresAt ?? Infinity;
  for (let i = 0; i < 45 && readExpiry() - Date.now() <= 40 * 60_000; i++) {
    spawnSync('claude', ['-p', '--model', 'claude-haiku-4-5-20251001', '--max-turns', '1', 'Reply OK'], { cwd: homedir(), encoding: 'utf8', timeout: 120_000 });
    if (readExpiry() - Date.now() > 40 * 60_000) break;
    spawnSync('sleep', ['60']);
  }
  log(`login token valid for ${Math.round((readExpiry() - Date.now()) / 60_000)} more minutes`);
}

/** Asks the subscription directly (one tiny haiku call) whether it will serve
 *  a request, and when the refusing window resets. */
function probeWindow() {
  const r = spawnSync('claude', ['-p', '--model', 'claude-haiku-4-5-20251001', '--max-turns', '1',
    '--output-format', 'stream-json', '--verbose', 'Reply OK'], { cwd: homedir(), encoding: 'utf8', timeout: 180_000 });
  let info = null;
  for (const line of (r.stdout ?? '').split('\n')) {
    try { const e = JSON.parse(line); if (e.type === 'rate_limit_event') info = e.rate_limit_info; } catch { /* not JSON */ }
  }
  return info;
}

/** Sleeps until the refusing window has reset, confirming with a probe. */
async function waitForWindow(hint) {
  for (;;) {
    const info = probeWindow() ?? {};
    if (info.status && info.status !== 'rejected') {
      log(`usage window open again (${info.status}; five-hour ${info.unifiedWindows?.five_hour?.utilization ?? '?'}, seven-day ${info.unifiedWindows?.seven_day?.utilization ?? '?'})`);
      return;
    }
    const resetsAt = (info.resetsAt ?? hint?.resetsAt ?? 0) * 1000;
    const waitMs = Math.max(5 * 60_000, Math.min(resetsAt - Date.now() + 120_000, 6 * 3_600_000));
    log(`usage limit reached (${info.rateLimitType ?? 'unknown window'}); sleeping ${Math.round(waitMs / 60_000)} min until ${new Date(Date.now() + waitMs).toISOString()}`);
    await sleep(waitMs);
  }
}

async function runCell(inst, arm, rep) {
  for (let attempt = 1; ; attempt++) {
    refreshTokenIfNeeded();
    const r = spawnSync('node', [join(HERE, 'run_instance.mjs'), arm, inst, String(rep), BUDGET, OUT], {
      cwd: ROOT, encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024,
    });
    const row = rows().find((x) => same(x, inst, arm, rep));
    if (row?.rateLimited) {
      log(`${inst} ${arm} rep ${rep}: refused by the usage limit after $${row.costUsd}; discarding and waiting`);
      discard(inst, arm, rep);
      await waitForWindow(row.usageWindow);
      continue;
    }
    if (row) {
      const w = row.usageWindow;
      log(`${inst} ${arm} rep ${rep}: ${row.state} $${row.costUsd} ${row.turns} turns${row.system1Judgments != null ? ` s1=${row.system1Judgments}/${row.system1Fallbacks}fb` : ''}${w ? ` [5h ${w.fiveHour} 7d ${w.sevenDay}]` : ''}`);
      return;
    }
    // The runner's own message, not its stack: the last lines of a Node error
    // are frames, which hid an expired-login refusal behind "at ModuleJob.run".
    const lines = (r.stderr || r.stdout || '').trim().split('\n');
    const err = (lines.find((l) => /failed:|Error:/.test(l)) ?? lines.slice(-3).join(' | ')).trim();
    log(`${inst} ${arm} rep ${rep}: runner exited ${r.status} without a row (attempt ${attempt}): ${err.slice(0, 400)}`);
    if (/usage limit|rate limit/i.test(err)) { await waitForWindow(null); continue; }
    if (/login (has expired|expires)/.test(err)) { refreshTokenIfNeeded(); continue; }
    if (attempt >= 3) {
      log(`${inst} ${arm} rep ${rep}: giving up after 3 attempts; the cell stays empty`);
      return;
    }
    await sleep(60_000);
  }
}

async function main() {
  log(`matrix start: ${INSTANCES.length} instances x ${REPS.length} reps x ${ARMS.length} arms, $${BUDGET} per run`);
  for (const rep of REPS) {
    for (const [i, inst] of INSTANCES.entries()) {
      for (const arm of shuffled(ARMS, rep * 1000 + i)) {
        if (rows().some((r) => same(r, inst, arm, rep) && !r.rateLimited)) continue;
        if (rows().some((r) => same(r, inst, arm, rep))) discard(inst, arm, rep);
        await runCell(inst, arm, rep);
      }
    }
  }
  const done = rows().length;
  log(`matrix runs finished: ${done}/${INSTANCES.length * REPS.length * ARMS.length} cells recorded`);
  log('grading with SWE-bench');
  const g = spawnSync('bash', [join(HERE, 'grade_matrix.sh')], { cwd: ROOT, env: { ...process.env, MATRIX_NAME: NAME }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  appendFileSync(LOG, (g.stdout ?? '').slice(-4000) + (g.stderr ?? '').slice(-4000));
  log(`grading exited ${g.status}`);
  const a = spawnSync(join(ROOT, '.swebench', 'bin', 'python3'), [join(HERE, 'analyze_matrix.py')], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, MATRIX_NAME: NAME } });
  appendFileSync(LOG, (a.stdout ?? '') + (a.stderr ?? ''));
  log(`analysis exited ${a.status}; MATRIX COMPLETE`);
}

main().catch((err) => {
  log(`driver crashed: ${err?.stack ?? err}`);
  process.exit(1);
});
