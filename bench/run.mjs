#!/usr/bin/env node
// Compare token usage / outcome with a knob on vs off, across a fixed goal set.
// Requires: a live kind Kubernetes cluster, `org` on PATH, and `claude login`
// (or ANTHROPIC_API_KEY) already configured — see bench/README.md. Each run
// dispatches real, paid model calls.
//
// Usage:
//   node bench/run.mjs repo-map      # ORG_REPO_MAP_TOKENS=6000 vs =0
//   node bench/run.mjs role-prompts  # ORG_ROLE_PROMPTS=on vs off   (Phase 3)
//   node bench/run.mjs efficiency    # ORG_EFFICIENCY_MODE=enabled vs disabled (Phase 4)
//   node bench/run.mjs turn-cap      # ORG_MAX_TURNS_EXECUTE=60 vs uncapped
//   node bench/run.mjs result-reuse  # ORG_RESULT_CACHE_TTL_HOURS=24 vs 0
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const mode = process.argv[2];
// `--goals=a,b` runs a subset. The full matrix is 7 goals x 2 arms, and the
// measured cost of the broad-review goal alone was 26% of a five-hour usage
// window in the `off` arm — so running everything exhausts the window and
// produces half a comparison. Scope it to the goals that exercise the knob.
const only = (process.argv.find((a) => a.startsWith('--goals=')) || '').slice(8)
  .split(',').map((s) => s.trim()).filter(Boolean);
const MATRIX = {
  'repo-map': [['on', { ORG_REPO_MAP_TOKENS: '6000' }], ['off', { ORG_REPO_MAP_TOKENS: '0' }]],
  'role-prompts': [['on', { ORG_ROLE_PROMPTS: 'on' }], ['off', { ORG_ROLE_PROMPTS: 'off' }]],
  // One switch over goal-aware context selection, conditional synthesis,
  // complexity-based model routing and the coherent-global-task split rule
  // together — which is what makes it a single comparable A/B rather than four
  // interacting ones. The two fixes that are *not* behind it are deliberate: the
  // cancelled-while-queued dispatch guard is a bug fix (nobody wants the arm
  // that pays for discarded work), and the planner turn cap and child cap have
  // their own knobs — ORG_MAX_TURNS_PLAN and ORG_MAX_CHILD_JOBS.
  efficiency: [['on', { ORG_EFFICIENCY_MODE: 'enabled' }], ['off', { ORG_EFFICIENCY_MODE: 'disabled' }]],
  // Their own knobs rather than rows of the `efficiency` switch, because what
  // they bound is not a decision the switch changes. Neither is expected to
  // separate on this goal set: 60 sits above every turn count ever measured
  // here, and result reuse only pays on a repeat. They are wired so that the
  // day a run does exceed the cap, or a goal is genuinely re-asked, the
  // comparison is one command rather than a code change.
  'turn-cap': [['on', { ORG_MAX_TURNS_EXECUTE: '60' }], ['off', { ORG_MAX_TURNS_EXECUTE: '0' }]],
  'result-reuse': [['on', { ORG_RESULT_CACHE_TTL_HOURS: '24' }], ['off', { ORG_RESULT_CACHE_TTL_HOURS: '0' }]],
};
if (!MATRIX[mode]) {
  console.error('mode must be one of: ' + Object.keys(MATRIX).join(', '));
  process.exit(2);
}

const all = JSON.parse(readFileSync(new URL('./goals.json', import.meta.url))).goals;
const goals = only.length > 0 ? all.filter((g) => only.includes(g.id)) : all;
if (goals.length === 0) {
  console.error(`no goals matched --goals=${only.join(',')}; available: ${all.map((g) => g.id).join(', ')}`);
  process.exit(2);
}
const sh = (cmd, args, env) => execFileSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env } });

// Poll `org tree` at most this many times (5s apart) before giving up rather
// than hanging forever on a node that never reaches a terminal state.
const MAX_POLLS = 360; // 30 minutes

const TERMINAL_STATES = ['COMPLETE', 'FAILED', 'CANCELLED'];

const results = [];

for (const [label, env] of MATRIX[mode]) {
  console.log(`\n=== ${mode}: ${label} ===`);
  sh('org', ['daemon', 'stop'], env); // restart so env is recaptured
  sh('org', ['daemon', 'start'], env);
  for (const g of goals) {
    const started = Date.now();
    const out = sh('org', ['run', g.goal], env);
    const id = (out.match(/Root node created: (\S+)/) || [])[1];
    if (!id) {
      throw new Error(
        `[${mode}:${label}:${g.id}] could not find "Root node created: <id>" in \`org run\` output — aborting rather than polling forever.\nOutput was:\n${out}`,
      );
    }
    let state = '';
    let polls = 0;
    while (!TERMINAL_STATES.includes(state)) {
      if (polls++ >= MAX_POLLS) {
        throw new Error(
          `[${mode}:${label}:${g.id}] node ${id} did not reach a terminal state (${TERMINAL_STATES.join('/')}) after ${MAX_POLLS} polls — aborting rather than hanging forever. Last state seen: ${state || '(none — id not found in \`org tree\`)'}`,
        );
      }
      await new Promise((r) => setTimeout(r, 5000));
      const line = sh('org', ['tree'], env).split('\n').find((l) => l.startsWith(id));
      state = (line || '').trim().split(/\s+/)[1] || '';
    }
    // `inputTokens` alone is the wrong headline. A measured dispatch reported
    // 22-46 input tokens against 1.77M cache-read: the bill is the conversation
    // prefix re-read every turn, so a comparison on input tokens compares two
    // rounding errors. Everything the provider actually billed is reported.
    const tokens = JSON.parse(sh('org', ['tokens', id, '--json'], env));
    const sum = (field) => tokens.rows.reduce((acc, r) => acc + (r[field] ?? 0), 0);
    const row = {
      goal: g.id,
      state,
      dispatches: sum('dispatches'),
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      cacheReadTokens: sum('cacheReadTokens'),
      costUsd: Number(sum('costUsd').toFixed(4)),
      planCacheHits: tokens.planCacheHits ?? 0,
      resultCacheHits: tokens.resultCacheHits ?? 0,
      wallSeconds: Number(((Date.now() - started) / 1000).toFixed(0)),
      models: tokens.rows.map((r) => `${r.role}:${r.model}`).join(' '),
      rubric: g.rubric,
    };
    results.push({ arm: label, ...row });
    console.log(JSON.stringify(row));
  }
}
// One table, both arms, and the deltas — so the answer is readable without
// re-deriving it from the log above.
const arms = [...new Set(results.map((r) => r.arm))];
const totals = arms.map((arm) => {
  const rows = results.filter((r) => r.arm === arm);
  const add = (field) => rows.reduce((acc, r) => acc + r[field], 0);
  return {
    arm,
    goals: rows.length,
    succeeded: rows.filter((r) => r.state === 'COMPLETE').length,
    dispatches: add('dispatches'),
    billedTokens: add('inputTokens') + add('outputTokens'),
    cacheReadTokens: add('cacheReadTokens'),
    costUsd: Number(add('costUsd').toFixed(4)),
    wallSeconds: add('wallSeconds'),
  };
});

console.log('\n=== totals ===');
for (const t of totals) console.log(JSON.stringify(t));

if (totals.length === 2) {
  const [on, off] = totals;
  const delta = (field) => (off[field] === 0 ? 0 : ((on[field] - off[field]) / off[field]) * 100);
  console.log('\n=== on vs off ===');
  console.log(JSON.stringify({
    dispatchesDeltaPct: Number(delta('dispatches').toFixed(1)),
    cacheReadDeltaPct: Number(delta('cacheReadTokens').toFixed(1)),
    costDeltaPct: Number(delta('costUsd').toFixed(1)),
    wallDeltaPct: Number(delta('wallSeconds').toFixed(1)),
    successOn: `${on.succeeded}/${on.goals}`,
    successOff: `${off.succeeded}/${off.goals}`,
  }, null, 2));
}

console.log('\nScore the rubric by hand. Ship criterion: cost per *successful* goal lower AND every rubric still passes.');
writeFileSync(new URL('./last-run.json', import.meta.url), JSON.stringify({ mode, results, totals }, null, 2));
console.log('Raw rows written to bench/last-run.json');
