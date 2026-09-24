#!/usr/bin/env node
/** Official grading for one Tier B result row: builds the task's own
 *  tests/Dockerfile verifier image (unmodified, cloned from the task repo)
 *  and runs its test.sh against the arm's resulting worktree, mounted at
 *  the paths the verifier expects (bench/tier-b/tasks.json `grading.mounts`).
 *  No self-report, no LLM judge -- matches PUBLIC-BENCHMARK-PROMPT-V2.md §7.4.
 *
 *  Usage: node grade.mjs <task_id> <worktreePath> <arm> <repetition>
 *  Prints {task_id, arm, repetition, resolved, reward, log} to stdout and
 *  appends a row to bench/tier-b/results/grading.jsonl.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, appendFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [, , taskId, worktreePath, arm, repetitionArg] = process.argv;
const repetition = Number(repetitionArg);
if (!taskId || !worktreePath || !arm || !Number.isFinite(repetition)) {
  console.error('usage: grade.mjs <task_id> <worktreePath> <arm> <repetition>');
  process.exit(2);
}

const TASKS = JSON.parse(readFileSync(join(import.meta.dirname, 'tasks.json'), 'utf8'));
const task = TASKS.tasks.find((t) => t.id === taskId);
if (!task) { console.error(`unknown tier-b task: ${taskId}`); process.exit(2); }

const TERMINAL_BENCH_REPO = join(resolve(import.meta.dirname, '..', '..'), '.bench', 'terminal-bench-repo');
const taskRepoDir = join(TERMINAL_BENCH_REPO, task.repo_dir);
const imageTag = `tier-b-verifier:${task.id}`;

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

// Build the verifier image once per task (cached by docker after the first call).
sh('docker', ['build', '-q', '-t', imageTag, join(taskRepoDir, 'tests')]);

// Must live under the repo, not the OS tmpdir: this host's docker daemon
// only bind-mounts paths under the project directory (confirmed empirically --
// writes into /tmp/.../scratchpad mounts vanish on the host side, the same
// constraint bench/lib/isolation.mjs documents for the kind cluster).
const tmpRoot = join(resolve(import.meta.dirname, '..', '..'), '.bench', 'tmp');
mkdirSync(tmpRoot, { recursive: true });
const logDirHost = mkdtempSync(join(tmpRoot, 'tier-b-verifier-'));
const runArgs = ['run', '--rm', '-v', `${logDirHost}:/logs/verifier`];
for (const m of task.grading.mounts) {
  const hostPath = resolve(worktreePath, m.hostRelative);
  if (!existsSync(hostPath)) {
    if (m.optional) continue;
    console.error(`grade.mjs: required output missing: ${hostPath}`);
  }
  if (existsSync(hostPath)) runArgs.push('-v', `${hostPath}:${m.containerPath}`);
}
runArgs.push(imageTag, 'bash', '-c', task.grading.command);

let dockerLog = '';
let dockerFailed = false;
try {
  dockerLog = sh('docker', runArgs);
} catch (err) {
  dockerFailed = true;
  dockerLog = (err.stdout || '') + (err.stderr || '');
}

// Two conventions coexist across Terminal-Bench tasks: some verifiers write
// reward.txt themselves (e.g. cargo-flight-dispatch); others only emit the
// CTRF pytest report and leave pass/fail aggregation to the caller (e.g.
// vba-userform-port -- confirmed empirically: its test.sh has no reward.txt
// write at all, yet its own pytest output prints "Reward: 1.0" and all
// tests pass). ctrf.json's summary is present for every task here and is
// the universal signal; reward.txt is treated as an authoritative override
// only when it disagrees by reporting failure (never silently overridden
// the other way).
let resolved = false;
let reward = 0;
const ctrfFile = join(logDirHost, 'ctrf.json');
if (existsSync(ctrfFile)) {
  const ctrf = JSON.parse(readFileSync(ctrfFile, 'utf8'));
  const summary = ctrf.results?.summary;
  if (summary && summary.tests > 0) {
    resolved = summary.failed === 0;
    reward = resolved ? 1 : 0;
  }
}
const rewardFile = join(logDirHost, 'reward.txt');
if (existsSync(rewardFile)) {
  const fileReward = Number(readFileSync(rewardFile, 'utf8').trim()) || 0;
  if (fileReward < 1) { resolved = false; reward = fileReward; }
}

const row = {
  tier: 'B', task_id: task.id, arm, repetition,
  resolved,
  reward,
  dockerRunFailed: dockerFailed,
  logTail: dockerLog.slice(-4000),
  gradedAt: new Date().toISOString(),
};
mkdirSync(join(import.meta.dirname, 'results'), { recursive: true });
appendFileSync(join(import.meta.dirname, 'results', 'grading.jsonl'), JSON.stringify(row) + '\n');
rmSync(logDirHost, { recursive: true, force: true });
console.log(JSON.stringify({ task_id: task.id, arm, repetition, resolved: row.resolved, reward }));
