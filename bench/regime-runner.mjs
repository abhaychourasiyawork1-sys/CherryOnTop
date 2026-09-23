#!/usr/bin/env node
// One-arm, streaming variant of run.mjs's dispatch loop, written for the regime
// suite (24 goals) after a background run.mjs invocation was killed mid-flight
// with no output flushed. Same retry/poll/token logic as run.mjs; the only
// difference is each row is appended to disk as soon as it is known, so a
// process death loses at most the goal in flight, not the whole arm.
//
// Usage: node bench/regime-runner.mjs <on|off> <outfile.jsonl>
import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync, existsSync, readFileSync as rf } from 'node:fs';
import {
  isolationFor, classifyFailure, dispatchFlags, dispatchConfig, MAX_ENVIRONMENT_RETRIES,
  environmentFingerprintOf, modelsOf, providerOf,
} from './compare.mjs';
import { classifyValidity } from './lib/validity.mjs';
import { materializeGoalWorktree, releaseGoalWorktree } from './lib/isolation.mjs';

const label = process.argv[2];
const outfile = process.argv[3];
if (label !== 'on' && label !== 'off') { console.error('usage: regime-runner.mjs <on|off> <outfile>'); process.exit(2); }

const knob = label === 'on' ? { ORG_EFFICIENCY_MODE: 'enabled' } : { ORG_EFFICIENCY_MODE: 'disabled' };
const isolation = isolationFor(label);
const env = { ...knob, ...isolation.env };

// The exact gap that produced the documented incident: this script dispatched
// every goal directly against the live working tree, no isolation between
// goals or between this arm and the other, and finished with 85 files of
// cross-contaminated edits still in it (2026-09-17-real-paid-benchmark-
// results.md §4). Every goal now forks its own worktree from the same frozen
// revision instead.
const repositoryRevision = (() => {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; }
})();
if (!repositoryRevision) {
  console.error('could not resolve the current revision (`git rev-parse HEAD` failed) — cannot isolate goal dispatches without one.');
  process.exit(2);
}
const environmentFingerprint = environmentFingerprintOf();

const fixtures = JSON.parse(readFileSync(new URL('./goals.json', import.meta.url)));
const goals = fixtures.regimes;

const sh = (cmd, args, e) => execFileSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...e } });
const TERMINAL_STATES = ['COMPLETE', 'FAILED', 'CANCELLED'];
const MAX_POLLS = 360;

// Resume support: skip goals already recorded in outfile from a prior partial run.
const done = new Set();
if (existsSync(outfile)) {
  for (const line of rf(outfile, 'utf8').split('\n').filter(Boolean)) {
    try { done.add(JSON.parse(line).goal); } catch {}
  }
}

const dispatch = dispatchConfig();
console.log(`=== regime-runner: ${label} (port ${isolation.port}) — ${goals.length} goals, ${done.size} already done ===`);
console.log(`dispatch: max-children=${dispatch.maxChildren} budget=$${dispatch.budgetUsd} spend-cap=$${dispatch.taskSpendCapUsd}`);
if (!dispatch.delegationReachable) console.log('  NOTE: delegation is NOT reachable this run.');
if (!dispatch.spendGuardEngaged) console.log('  NOTE: the spend guard is NOT engaged this run.');
sh('org', ['daemon', 'stop'], env);
sh('org', ['daemon', 'start'], env);

function runGoal(attempt, context) {
  for (let tries = 0; tries <= MAX_ENVIRONMENT_RETRIES; tries++) {
    try { return { ok: true, value: attempt() }; } catch (err) {
      const verdict = classifyFailure(`${err?.message ?? ''}\n${err?.stdout ?? ''}\n${err?.stderr ?? ''}`);
      if (!verdict.retryable) return { ok: false, verdict, error: err };
      if (tries === MAX_ENVIRONMENT_RETRIES) {
        console.error(`[${context}] gave up after ${tries + 1} attempts: ${verdict.kind}`);
        return { ok: false, verdict, error: err };
      }
      console.error(`[${context}] ${verdict.kind}; retrying (${tries + 1}/${MAX_ENVIRONMENT_RETRIES})`);
    }
  }
  return { ok: false, verdict: { retryable: false, kind: 'unknown', scope: 'product' } };
}

for (const g of goals) {
  if (done.has(g.id)) { console.log(`skip (already recorded): ${g.id}`); continue; }
  const worktree = materializeGoalWorktree(process.cwd(), repositoryRevision, `${label}:${g.id}`);
  let row;
  try {
    const started = Date.now();
    const launched = runGoal(() => sh('org', ['run', g.goal, '--repo', worktree.path, ...dispatchFlags()], env), `${label}:${g.id}`);
    if (!launched.ok) {
      row = { arm: label, goal: g.id, regime: g.regime, size: g.size, state: 'UNRUNNABLE', failureScope: launched.verdict.scope, failureKind: launched.verdict.kind, repositoryRevision, environmentFingerprint, economic: [] };
    } else {
      const out = launched.value;
      const id = (out.match(/Root node created: (\S+)/) || [])[1];
      if (!id) {
        row = { arm: label, goal: g.id, regime: g.regime, size: g.size, state: 'UNRUNNABLE', failureScope: 'product', failureKind: 'no-node-id', repositoryRevision, environmentFingerprint, economic: [] };
      } else {
        let state = '';
        let polls = 0;
        while (!TERMINAL_STATES.includes(state)) {
          if (polls++ >= MAX_POLLS) { state = 'TIMEOUT'; break; }
          execFileSync('sleep', ['5']);
          const line = sh('org', ['tree'], env).split('\n').find((l) => l.startsWith(id));
          state = (line || '').trim().split(/\s+/)[1] || '';
        }
        const tokensOut = sh('org', ['tokens', id, '--json', '--economic'], env);
        const tokens = JSON.parse(tokensOut);
        const sum = (field) => tokens.rows.reduce((acc, r) => acc + (r[field] ?? 0), 0);
        row = {
          arm: label, goal: g.id, regime: g.regime, size: g.size, family: g.family ?? 'unknown', state, nodeId: id,
          dispatches: sum('dispatches'), turns: sum('turns'), inputTokens: sum('inputTokens'),
          outputTokens: sum('outputTokens'), cacheReadTokens: sum('cacheReadTokens'),
          costUsd: Number(sum('costUsd').toFixed(4)),
          planCacheHits: tokens.planCacheHits ?? 0, resultCacheHits: tokens.resultCacheHits ?? 0,
          wallSeconds: Number(((Date.now() - started) / 1000).toFixed(0)),
          rubric: g.rubric, repositoryRevision, environmentFingerprint, models: modelsOf(tokens),
          provider: providerOf(),
          economic: tokens.economic ?? [],
        };
      }
    }
  } finally {
    releaseGoalWorktree(process.cwd(), worktree.path);
  }
  // Classified at the moment it is written, not when it is read back. A row
  // that reached disk without its validity class is a row somebody will later
  // average into a headline number.
  const verdict = classifyValidity(row, { repositoryRevision });
  appendFileSync(outfile, JSON.stringify({ ...row, ...verdict }) + '\n');
  console.log(JSON.stringify({
    goal: row.goal, state: row.state, validity: verdict.validity,
    costUsd: row.costUsd, turns: row.turns,
    ...(verdict.validity === 'VALID' ? {} : { reason: verdict.reason }),
  }));
}
console.log(`=== regime-runner: ${label} done ===`);
