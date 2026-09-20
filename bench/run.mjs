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
import { summarizeEconomicRun, compareArms, renderComparison } from './metrics/economic.mjs';
import {
  isolationFor, classifyFailure, runMetadata, validateMetadata,
  pairRuns, pairedDifference, dispatchFlags, dispatchConfig, MAX_ENVIRONMENT_RETRIES,
  environmentFingerprintOf, modelsOf,
} from './compare.mjs';
import { materializeGoalWorktree, releaseGoalWorktree } from './lib/isolation.mjs';
import { partitionByValidity, renderValidity } from './lib/validity.mjs';

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
  // The token-efficiency *architecture* switch: structural candidates,
  // composable scoring, progressive selection, adaptive turn budget. `off`
  // returns the lexical selector and the flat turn cap this branch shipped
  // with, which is exactly the arm the recorded baseline was measured on — so
  // the two arms are comparable by construction rather than by argument.
  //
  // The spend guard is deliberately *not* behind it: a hard ceiling on money
  // is a safety property, and an arm that runs without one is not a control,
  // it is an unbounded bill.
  'context-planner': [['on', { ORG_CONTEXT_PLANNER: 'on' }], ['off', { ORG_CONTEXT_PLANNER: 'off' }]],
};
if (!MATRIX[mode]) {
  console.error('mode must be one of: ' + Object.keys(MATRIX).join(', '));
  process.exit(2);
}

const fixtures = JSON.parse(readFileSync(new URL('./goals.json', import.meta.url)));
// The frozen baseline population, and nothing else, unless --families is asked
// for explicitly. Adding a goal to the default set would silently change what
// "the baseline" means, and every later comparison would be against a number
// no earlier run produced.
// `--regimes` selects the regime suite instead of the frozen population: those
// goals are grouped by the *shape of the economic situation* rather than by kind
// of work, which is what makes a regression attributable to a situation the
// policy mishandles rather than to a task it has not seen.
const all = process.argv.includes('--regimes')
  ? fixtures.regimes
  : process.argv.includes('--families')
    ? [...fixtures.goals, ...fixtures.families]
    : fixtures.goals;
const goals = only.length > 0 ? all.filter((g) => only.includes(g.id)) : all;
if (goals.length === 0) {
  console.error(`no goals matched --goals=${only.join(',')}; available: ${all.map((g) => g.id).join(', ')}`);
  process.exit(2);
}
const sh = (cmd, args, env) => execFileSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env } });

/** What the whole comparison ran against. Captured once, before anything runs,
 *  because a result without it is an anecdote about a terminal somebody had
 *  open. */
const git = (args) => {
  try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); } catch { return null; }
};
const startedAt = new Date().toISOString();
const repositoryRevision = git(['rev-parse', 'HEAD']);
const repositoryDirty = (git(['status', '--porcelain']) ?? 'unknown') !== '';
const environmentFingerprint = environmentFingerprintOf();

/** One goal, run once, with environment failures retried and product failures
 *  recorded.
 *
 *  Getting the distinction wrong corrupts the comparison in both directions:
 *  retrying a real product failure hides it, and recording an expired token as a
 *  product failure invents one. */
function runGoal(attempt, context) {
  for (let tries = 0; tries <= MAX_ENVIRONMENT_RETRIES; tries++) {
    try {
      return { ok: true, value: attempt() };
    } catch (err) {
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

// Poll `org tree` at most this many times (5s apart) before giving up rather
// than hanging forever on a node that never reaches a terminal state.
const MAX_POLLS = 360; // 30 minutes

const TERMINAL_STATES = ['COMPLETE', 'FAILED', 'CANCELLED'];

const dispatch = dispatchConfig();
console.log(`dispatch: max-children=${dispatch.maxChildren} budget=$${dispatch.budgetUsd} spend-cap=$${dispatch.taskSpendCapUsd}`);
if (!dispatch.delegationReachable) {
  console.log('  NOTE: delegation is NOT reachable this run (needs ORG_BENCH_MAX_CHILDREN>0 and ORG_BENCH_BUDGET_USD>=1).');
  console.log('        Nothing below says anything about delegation, the work-graph scheduler, or the execution veto.');
}
if (!dispatch.spendGuardEngaged) {
  console.log('  NOTE: the spend guard is NOT engaged (needs ORG_TASK_SPEND_CAP_USD>0). The hard-budget regime will not test a cap.');
}

const results = [];

// Each arm gets its own port and database. Two arms sharing a SQLite file is
// not a subtle contamination: the second reads the first's efficiency records
// and reports them as its own.
const isolation = Object.fromEntries(MATRIX[mode].map(([label]) => [label, isolationFor(label)]));

for (const [label, knob] of MATRIX[mode]) {
  const env = { ...knob, ...isolation[label].env };
  console.log(`\n=== ${mode}: ${label} (port ${isolation[label].port}) ===`);
  sh('org', ['daemon', 'stop'], env); // restart so env is recaptured
  sh('org', ['daemon', 'start'], env);
  if (!repositoryRevision) {
    throw new Error('could not resolve the current revision (`git rev-parse HEAD` failed) — cannot isolate goal dispatches without one.');
  }
  for (const g of goals) {
    // Every goal, in every arm, forks from the exact same commit into its own
    // worktree — never the live working tree, and never a worktree any other
    // goal or arm also writes to. This is the invariant a real paid run
    // violated (§4 of the 2026-09-17 report): dispatching directly against
    // the shared tree let 48 goals' edits pile on top of each other with zero
    // isolation between them.
    const worktree = materializeGoalWorktree(process.cwd(), repositoryRevision, `${label}:${g.id}`);
    try {
      const started = Date.now();
      const launched = runGoal(
        () => sh('org', ['run', g.goal, '--repo', worktree.path, ...dispatchFlags()], env),
        `${mode}:${label}:${g.id}`,
      );
      if (!launched.ok) {
        // Recorded rather than thrown: one unrunnable goal must not take down the
        // other six, and a report that omits it reads as a claim about all seven.
        results.push({
          arm: label, goal: g.id, size: g.size ?? 'unknown', family: g.family ?? 'unknown',
          regime: g.regime ?? 'unknown', state: 'UNRUNNABLE',
          failureScope: launched.verdict.scope, failureKind: launched.verdict.kind,
          repositoryRevision, environmentFingerprint, economic: [],
        });
        console.log(JSON.stringify({ goal: g.id, state: 'UNRUNNABLE', ...launched.verdict }));
        continue;
      }
      const out = launched.value;
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
      // `--economic` adds what the control plane decided, predicted and cost.
      // Asked for here and nowhere else: a bare `--json` keeps the shape every
      // other caller already parses.
      const tokens = JSON.parse(sh('org', ['tokens', id, '--json', '--economic'], env));
      const sum = (field) => tokens.rows.reduce((acc, r) => acc + (r[field] ?? 0), 0);
      const row = {
        goal: g.id,
        size: g.size ?? 'unknown',
        family: g.family ?? 'unknown',
        regime: g.regime ?? 'unknown',
        state,
        dispatches: sum('dispatches'),
        // The term nothing bounded before, and the one the architecture is meant
        // to move: cost inside a dispatch grows superlinearly in turns, because
        // the whole conversation prefix is re-read on every one.
        turns: sum('turns'),
        inputTokens: sum('inputTokens'),
        outputTokens: sum('outputTokens'),
        cacheReadTokens: sum('cacheReadTokens'),
        costUsd: Number(sum('costUsd').toFixed(4)),
        planCacheHits: tokens.planCacheHits ?? 0,
        resultCacheHits: tokens.resultCacheHits ?? 0,
        wallSeconds: Number(((Date.now() - started) / 1000).toFixed(0)),
        models: modelsOf(tokens),
        rubric: g.rubric,
        // Everything that has to match for two runs to be the same experiment.
        // Recorded per row so pairing is a property of the data rather than an
        // assumption made afterwards.
        repositoryRevision,
        provider: process.env.ANTHROPIC_API_KEY ? 'anthropic-api-key' : 'anthropic-oauth',
        environmentFingerprint,
      };
      results.push({ arm: label, ...row, economic: tokens.economic ?? [] });
      console.log(JSON.stringify(row));
    } finally {
      // Always, whether the goal completed, was recorded UNRUNNABLE, or this
      // aborted with a thrown error: a leaked worktree is a smaller failure
      // than a leaked worktree that later gets reused and silently carries
      // one goal's edits into another's dispatch.
      releaseGoalWorktree(process.cwd(), worktree.path);
    }
  }
}
// Which rows are evidence about the product, and which are evidence about the
// harness. Done before anything is summed: a comparison that averages an
// unschedulable cluster or an impossible cost row into its headline number is
// not a comparison, and the previous harness had no way to tell.
const partition = partitionByValidity(results, {
  repositoryRevision,
  environmentFingerprint,
});
console.log('\n=== validity ===');
console.log(renderValidity(partition));
const valid = partition.valid;
if (valid.length === 0) {
  console.error('No valid rows. Nothing below describes the product — fix the harness and re-run.');
}

// One table, both arms, and the deltas — so the answer is readable without
// re-deriving it from the log above.
const arms = [...new Set(valid.map((r) => r.arm))];
const totals = arms.map((arm) => {
  const rows = valid.filter((r) => r.arm === arm);
  const add = (field) => rows.reduce((acc, r) => acc + r[field], 0);
  return {
    arm,
    goals: rows.length,
    succeeded: rows.filter((r) => r.state === 'COMPLETE').length,
    dispatches: add('dispatches'),
    turns: add('turns'),
    billedTokens: add('inputTokens') + add('outputTokens'),
    cacheReadTokens: add('cacheReadTokens'),
    costUsd: Number(add('costUsd').toFixed(4)),
    wallSeconds: add('wallSeconds'),
    // Carried into the totals rather than only printed above, so a stored
    // result file cannot be read later as if every attempted goal counted.
    excluded: partition.invalid.filter((r) => r.arm === arm).length,
  };
});

// The acceptance metrics are all *per success*. A change that halves cost by
// failing twice as often has not improved anything, and a raw total hides it.
for (const t of totals) {
  const per = (n) => (t.succeeded === 0 ? null : Number((n / t.succeeded).toFixed(4)));
  t.costPerSuccess = per(t.costUsd);
  t.turnsPerSuccess = per(t.turns);
  t.cacheReadPerSuccess = per(t.cacheReadTokens);
}

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

// A recorded run to compare against, so "did the new policy help?" is answered
// from two matched files rather than from memory of a number in a terminal.
const baselineArg = (process.argv.find((a) => a.startsWith('--baseline=')) || '').slice(11);
if (baselineArg) {
  const prior = JSON.parse(readFileSync(baselineArg, 'utf8'));
  const pick = (run, arm) => run.totals.find((t) => t.arm === arm) ?? run.totals[0];
  const a = pick(prior, 'on');
  const b = pick({ totals }, 'on');
  const pct = (field) => (a[field] ? Number((((b[field] - a[field]) / a[field]) * 100).toFixed(1)) : 0);
  console.log(`\n=== vs baseline ${baselineArg} ===`);
  console.log(JSON.stringify({
    successBaseline: `${a.succeeded}/${a.goals}`,
    successNow: `${b.succeeded}/${b.goals}`,
    costPerSuccessDeltaPct: pct('costPerSuccess'),
    turnsPerSuccessDeltaPct: pct('turnsPerSuccess'),
    cacheReadPerSuccessDeltaPct: pct('cacheReadPerSuccess'),
    wallDeltaPct: pct('wallSeconds'),
  }, null, 2));
}

// The economic comparison: the primary metric first, with quality and latency
// beside it, and every component of the spend so a regression can be attributed
// rather than only observed.
if (arms.length === 2) {
  const armRecords = (arm) => valid.filter((r) => r.arm === arm).flatMap((r) => r.economic ?? []);
  // `on` is the Full Architecture arm in every matrix row, and `off` is
  // Baseline — named for the knob rather than the architecture, which is why
  // they are re-labelled here rather than relied on positionally elsewhere.
  const full = summarizeEconomicRun(armRecords(arms[0]));
  const baselineSummary = summarizeEconomicRun(armRecords(arms[1]));
  if (full.tasks > 0 && baselineSummary.tasks > 0) {
    const comparison = compareArms(baselineSummary, full);
    console.log('\n=== economic comparison (baseline vs full architecture) ===\n');
    console.log(renderComparison(baselineSummary, full, comparison));
  } else {
    console.log('\n=== economic comparison ===');
    console.log('No efficiency records were produced by one or both arms; nothing to compare.');
  }
}

console.log('\nScore the rubric by hand. Ship criterion: cost per *successful* goal lower AND every rubric still passes.');
const label = (process.argv.find((a) => a.startsWith('--label=')) || '').slice(8) || 'last-run';

const metadata = runMetadata({
  startedAt,
  mode,
  goalSet: process.argv.includes('--regimes') ? 'regimes' : process.argv.includes('--families') ? 'goals+families' : 'goals',
  goalIds: goals.map((g) => g.id),
  repositoryRevision,
  repositoryDirty,
  nodeVersion: process.version,
  provider: process.env.ANTHROPIC_API_KEY ? 'anthropic-api-key' : 'anthropic-oauth',
  models: [...new Set(results.map((r) => r.models).filter(Boolean))].join(' | '),
  runnerImage: process.env.ORG_RUNNER_IMAGE ?? 'cherryontop-runner:local',
  policyVersions: results.flatMap((r) => (r.economic ?? []).map((e) => e.policyVersion)).filter(Boolean),
  arms: Object.values(isolation),
  dispatch,
});

const reproducible = validateMetadata(metadata);
if (!reproducible.reproducible) {
  console.log('\n=== this run is not fully reproducible ===');
  for (const problem of reproducible.problems) console.log(`  ${problem}`);
  console.log('Read the numbers above with that in mind.');
}

// Paired differences, goal by goal. The honest form of the comparison: a mean
// over unpaired runs of different goals is a number nothing produced.
if (arms.length === 2) {
  // Valid rows only. Pairing an infrastructure failure against a real run
  // produces a difference that describes the cluster.
  const rowsFor = (arm) => valid.filter((r) => r.arm === arm)
    .map((r) => ({ ...r, billedTokens: r.inputTokens + r.outputTokens }));
  const { pairs, reasons } = pairRuns(rowsFor(arms[1]), rowsFor(arms[0]));
  console.log('\n=== paired differences (full architecture minus baseline) ===');
  if (reasons.length > 0) console.log(`  could not pair: ${reasons.join(', ')}`);
  for (const metric of ['billedTokens', 'turns', 'costUsd', 'wallSeconds']) {
    const difference = pairedDifference(pairs, metric);
    console.log(JSON.stringify({
      metric,
      n: difference.n,
      meanPercent: difference.meanPercent === null ? null : Number(difference.meanPercent.toFixed(1)),
      better: difference.wins,
      worse: difference.losses,
      evidence: difference.evidence,
    }));
  }
}

const out = new URL(`./${label}.json`, import.meta.url);
// Every row is stored, classified — not only the valid ones. A stored file
// that silently omitted what it excluded would be the same defect one layer
// down.
writeFileSync(out, JSON.stringify({
  mode, label, metadata, reproducible,
  validity: partition.counts,
  results: partition.rows,
  totals,
}, null, 2));
console.log(`Raw rows written to bench/${label}.json`);
