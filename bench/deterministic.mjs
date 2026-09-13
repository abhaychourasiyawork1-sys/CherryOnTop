#!/usr/bin/env node
// Measures the token effect of every deterministic optimization in this branch,
// with **no model calls and no cluster**. Run: `node bench/deterministic.mjs`
// (after `npm run build`).
//
// This is the cheap arm of the benchmark hierarchy. It can measure exactly the
// things that are decided by arithmetic — how much a reducer removes, how large
// a projection is, which representation a budget buys, how many dispatches a
// decision avoids — and it deliberately measures nothing that needs inference,
// because a number produced by a model is not a number this harness can stand
// behind.
import { projectObservation } from '../dist/execution/tool-projections/registry.js';
import { selectDispatchContext } from '../dist/context/dispatch-context.js';
import { reduceGeneric } from '../dist/execution/observation-reducer.js';
import { planEvidence } from '../dist/execution/evidence-planner.js';
import { updateFrontier, EMPTY_FRONTIER } from '../dist/context/frontier.js';
import { decideExecutionPath } from '../dist/decision/engine.js';
import { judgeTask } from '../dist/intelligence/task-judge.js';

const CHARS_PER_TOKEN = 4;
const tokens = (text) => Math.ceil(text.length / CHARS_PER_TOKEN);
// Fixed locale: the grouping in this table should not depend on where it runs.
const num = (value) => value.toLocaleString('en-US');
const pct = (before, after) => (before === 0 ? 0 : ((before - after) / before) * 100);

function table(title, rows, columns) {
  console.log(`\n## ${title}\n`);
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => `| ${cells.map((cell, i) => String(cell).padEnd(widths[i])).join(' | ')} |`;
  console.log(line(columns));
  console.log(`|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`);
  for (const row of rows) console.log(line(row));
}

// ---------------------------------------------------------------- observations
const observation = (command, raw, name = 'Bash') => ({
  observationId: 'o', tool: { name, operation: name === 'Bash' ? command.split(/\s+/).slice(0, 2).join('/') : undefined },
  invocation: { callId: 't', input: { command } },
  execution: { nodeId: 'n', sequence: 0, succeeded: true },
  raw, semanticId: 'observation:x',
});

const testLog = [
  ...Array.from({ length: 2000 }, (_, i) => `✓ src/module-${i}.test.ts > a reasonably long test name here`),
  'FAIL src/auth.test.ts > refuses an expired token',
  'AssertionError: expected true to be false',
  ' ❯ src/auth.test.ts:42:19',
  ' Tests  1 failed | 2000 passed (2001)',
].join('\n');

const diff = Array.from({ length: 200 }, (_, i) => [
  `diff --git a/src/f${i}.ts b/src/f${i}.ts`,
  '@@ -1,10 +1,10 @@',
  ...Array.from({ length: 10 }, (_, j) => ` const untouched${j} = ${i};`),
].join('\n')).join('\n');

const installLog = [
  ...Array.from({ length: 800 }, () => 'reify:lodash: timing reifyNode:node_modules/lodash Completed in 3ms'),
  'npm ERR! code ELIFECYCLE',
  'added 402 packages in 9s',
].join('\n');

const searchOut = Array.from({ length: 500 }, (_, i) =>
  `src/module-${i}.ts:${i}:export function handler${i}() {\nsrc/module-${i}.ts-${i + 1}-  return 1;`).join('\n');

const observations = [
  ['test runner (2001 tests, 1 failing)', 'pnpm test', testLog],
  ['git diff (200 files)', 'git diff', diff],
  ['package install log', 'npm install', installLog],
  ['ripgrep with context lines', 'rg handler', searchOut],
];

table('Observation reduction — deterministic, no model', observations.map(([label, command, raw]) => {
  const projected = projectObservation(observation(command, raw));
  return [
    label, projected.projection,
    num(tokens(raw)),
    num(tokens(projected.text)),
    `${pct(tokens(raw), tokens(projected.text)).toFixed(1)}%`,
  ];
}), ['output', 'reducer', 'tokens before', 'tokens after', 'removed']);

// The fallback, measured separately — it is what unrecognised output gets.
const unknown = Array.from({ length: 1000 }, (_, i) => `bespoke-tool: step ${i} complete`).join('\n');
table('Generic fallback (no reducer claims the output)', [[
  'unknown tool, 1000 lines',
  num(tokens(unknown)),
  num(tokens(reduceGeneric(unknown, 60).text)),
  `${pct(tokens(unknown), tokens(reduceGeneric(unknown, 60).text)).toFixed(1)}%`,
]], ['output', 'tokens before', 'tokens after', 'removed']);

// ------------------------------------------------------------------ projection
// Real edges, so the structural planner has something to be structural about:
// each module imports the one five before it (a different area), and every
// tenth module has a test beside it. A tree of unconnected files would flatter
// the lexical selector by giving the structural one nothing to find.
const entries = Array.from({ length: 600 }, (_, i) => ({
  path: `src/${['auth', 'cart', 'session', 'billing', 'search'][i % 5]}/module-${i}.ts`,
  symbols: [`handler${i}`, `validate${i}`, `serialize${i}`],
  imports: i >= 5 ? [`../${['auth', 'cart', 'session', 'billing', 'search'][(i - 5) % 5]}/module-${i - 5}.js`] : [],
}));
for (let i = 0; i < 600; i += 10) {
  const area = ['auth', 'cart', 'session', 'billing', 'search'][i % 5];
  entries.push({ path: `src/${area}/module-${i}.test.ts`, symbols: [], imports: [`./module-${i}.js`] });
}

const projections = [
  ['names one area', 'Fix the expired-token bug in the auth session handler'],
  ['names many modules', 'Audit every module handler and validate serialization'],
  ['names no file or symbol', 'Review the codebase and find bugs'],
  ['names nothing in this tree', 'Update the Kubernetes ingress annotations'],
];

table('Context projection against a 600-file tree, 6000-token ceiling', projections.map(([label, goal]) => {
  const selected = selectDispatchContext({ goal, entries, tokenBudget: 6000 });
  const full = entries.map((e) => `  ${e.path}: ${e.symbols.join(', ')}`).join('\n');
  return [
    label,
    num(tokens(full)),
    num(selected.estimatedTokens),
    `${selected.receipt.selected.length}/${entries.length}`,
    // The ceiling is not a target: an unused budget is the correct outcome for
    // a goal that points at little.
    `${((selected.estimatedTokens / 6000) * 100).toFixed(0)}%`,
  ];
}), ['goal', 'whole inventory', 'projected', 'files kept', 'ceiling used']);

// --------------------------------------------------- planner vs lexical selector
// The A/B this architecture is actually about, measured with no model and no
// cluster. What it can show: how much context each selector hands over, and
// whether the structural one reaches files the lexical one cannot see. What it
// cannot show: whether that changes turns or cost, which needs a paid run.
const plannerGoals = [
  ['anchored one-file edit', 'Fix the expired-token bug in src/auth/module-5.ts'],
  ['anchored with callers', 'Rename handler10 in src/auth/module-10.ts and update every caller'],
  ['names an area only', 'Audit the billing modules for missing validation'],
  ['names nothing specific', 'Review the codebase and find bugs'],
];

function selectUnder(goal, planner) {
  const previous = process.env.ORG_CONTEXT_PLANNER;
  process.env.ORG_CONTEXT_PLANNER = planner;
  try {
    return selectDispatchContext({ goal, entries, tokenBudget: 6000 });
  } finally {
    if (previous === undefined) delete process.env.ORG_CONTEXT_PLANNER;
    else process.env.ORG_CONTEXT_PLANNER = previous;
  }
}

table('Structural planner vs lexical selector, same tree and ceiling', plannerGoals.map(([label, goal]) => {
  const lexical = selectUnder(goal, 'off');
  const structural = selectUnder(goal, 'on');
  const reached = structural.receipt.selected.filter((p) => !lexical.receipt.selected.includes(p));
  return [
    label,
    num(lexical.estimatedTokens),
    num(structural.estimatedTokens),
    `${((structural.estimatedTokens / 6000) * 100).toFixed(0)}%`,
    `${lexical.receipt.selected.length} -> ${structural.receipt.selected.length}`,
    num(reached.length),
  ];
}), ['goal', 'lexical tokens', 'planner tokens', 'ceiling used', 'files kept', 'newly reached']);

// ------------------------------------------------------------------- decisions
const dispatch = { tokens: 1_772_218, latencyMs: 263_000, costUsd: 0.95 };
const authority = { tools: [], spawn_children: true, max_child_count: 2, budget_usd: 5 };

const goals = [
  'Review the codebase and find bugs. Do not modify anything.',
  'Fix authentication, optimise the DB query layer, and add API tests',
  'Fix the typo in the README',
  'Investigate the root cause of this bug',
];

table('Execution path, from the goal alone — no model consulted', goals.map((goal) => {
  const verdict = judgeTask(goal);
  const decision = decideExecutionPath({
    goal, authority, spentUsd: 0,
    complexity: verdict.decomposition.complexity,
    worthSplitting: verdict.decomposition.worthSplitting,
    signals: verdict.decomposition.signals,
    dispatch,
  });
  return [
    goal.length > 46 ? `${goal.slice(0, 43)}...` : goal,
    verdict.taskClass, verdict.decomposition.complexity,
    verdict.worthPlanning ? 'yes' : 'no',
    decision.chosen,
  ];
}), ['goal', 'class', 'complexity', 'plans?', 'decision']);

// Reuse, priced from the measured run.
const reuse = decideExecutionPath({
  goal: goals[0], authority, spentUsd: 0, complexity: 'medium', worthSplitting: false,
  dispatch, reusable: { tokens: dispatch.tokens, costUsd: dispatch.costUsd },
});
table('A valid prior answer', [[
  reuse.chosen,
  num(reuse.estimate.tokens),
  num(reuse.alternatives[0].estimate.tokens),
  `$${reuse.alternatives[0].estimate.costUsd.toFixed(2)}`,
]], ['decision', 'tokens spent', 'tokens avoided', 'cost avoided']);

// -------------------------------------------------------------------- evidence
const ref = (id) => ({ semanticId: id, version: 1, contentHash: `h-${id}` });
const open = updateFrontier(EMPTY_FRONTIER, { raised: [ref('a')] });
const candidates = [
  { action: 'run_model', estimatedTokens: dispatch.tokens, estimatedLatencyMs: dispatch.latencyMs, expectedGain: 0.9, reason: 'a dispatch' },
  { action: 'search', estimatedTokens: 200, estimatedLatencyMs: 500, expectedGain: 0.4, reason: 'a search' },
  { action: 'reuse', estimatedTokens: 400, estimatedLatencyMs: 0, expectedGain: 1, reason: 'held' },
];

const evidence = (situation, frontier, options) => {
  const plan = planEvidence(frontier, options);
  return [
    situation,
    plan.chosen ? plan.chosen.action : `stop (${plan.reason.slice(0, 44)}...)`,
    num(plan.chosen ? plan.chosen.estimatedTokens : 0),
  ];
};

table('Evidence planning', [
  evidence('all three available', open, candidates),
  evidence('only a search', open, [candidates[1]]),
  // Declining a 1.77M-token dispatch to close one small gap is the intended
  // behaviour, not a bug: this is the *next observation* question, not whether
  // the task runs at all.
  evidence('only a full dispatch', open, [candidates[0]]),
  evidence('nothing outstanding', EMPTY_FRONTIER, candidates),
], ['situation', 'chosen', 'tokens']);

console.log('\nNo model was called and no cluster was used. Every number above is\narithmetic over fixtures, reproducible by re-running this file.\n');
