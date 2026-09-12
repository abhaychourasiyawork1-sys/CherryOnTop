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
import { readFileSync } from 'node:fs';

const mode = process.argv[2];
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

const { goals } = JSON.parse(readFileSync(new URL('./goals.json', import.meta.url)));
const sh = (cmd, args, env) => execFileSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env } });

// Poll `org tree` at most this many times (5s apart) before giving up rather
// than hanging forever on a node that never reaches a terminal state.
const MAX_POLLS = 360; // 30 minutes

const TERMINAL_STATES = ['COMPLETE', 'FAILED', 'CANCELLED'];

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
    const tokens = JSON.parse(sh('org', ['tokens', id, '--json'], env));
    const totalIn = tokens.rows.reduce((s, r) => s + r.inputTokens, 0);
    console.log(`${g.id}\t${state}\t${totalIn} in-tokens\t${((Date.now() - started) / 1000).toFixed(0)}s\trubric: ${g.rubric}`);
  }
}
console.log('\nScore the rubric column by hand. Ship criterion: total in-tokens lower AND every rubric still passes.');
