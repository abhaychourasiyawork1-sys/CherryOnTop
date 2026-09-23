#!/usr/bin/env node
// Does the spend guard stop the right runs?
//
// A guard is judged by its mistakes, not by its rules. Two of them, and they
// cost entirely different things:
//
//   - a **false positive** kills work that was going to succeed. The user
//     loses the answer and pays for everything spent up to the moment it was
//     killed. This is the expensive mistake.
//   - a **false negative** lets a doomed run spend its whole allowance. The
//     user loses money and gets the same non-answer they were going to get.
//
// So the guard is deliberately biased: it would rather let a bad run finish
// than kill a good one, and the table below is how that bias is checked rather
// than asserted. Every trajectory is synthetic, every verdict is arithmetic —
// no model, no cluster. Run: `node bench/economic-trajectories.mjs` (after
// `npm run build`).
import { evaluateSpendGuard } from '../dist/efficiency/spend-guard.js';
import { summarizeExecutionTrajectory } from '../dist/efficiency/progress-signals.js';

let nextId = 0;
const step = (name, input, failed = false) => {
  const id = `t${nextId++}`;
  return [
    { type: 'assistant', payload: { message: { content: [{ type: 'tool_use', id, name, input }] } } },
    { type: 'user', payload: { message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'out', is_error: failed }] } } },
  ];
};
const trace = (steps) => steps.flatMap(([name, input, failed]) => step(name, input, failed));
const repeat = (n, make) => Array.from({ length: n }, (_, i) => make(i));

// Each case: what the run is really doing, and whether a human would want it
// stopped at this point. `shouldStop` is the ground truth the guard is scored
// against.
const CASES = [
  {
    name: 'productive edit + green tests',
    shouldStop: false,
    spentUsd: 3, turns: 18,
    events: trace([
      ['Read', { file_path: 'src/a.ts' }], ['Edit', { file_path: 'src/a.ts' }],
      ['Bash', { command: 'npm test' }], ['Edit', { file_path: 'src/b.ts' }],
      ['Bash', { command: 'npm test' }],
    ]),
  },
  {
    name: 'expensive but productive debugging',
    shouldStop: false,
    spentUsd: 8.5, turns: 42,
    events: trace([
      ...repeat(6, (i) => ['Read', { file_path: `src/${i}.ts` }]),
      ...repeat(3, (i) => ['Grep', { pattern: `symptom-${i}` }]),
      ['Edit', { file_path: 'src/fix.ts' }], ['Bash', { command: 'npm test' }],
      ['Edit', { file_path: 'src/fix2.ts' }], ['Bash', { command: 'npm test' }],
    ]),
  },
  {
    name: 'slow start — three reads, nothing else yet',
    shouldStop: false,
    spentUsd: 0.4, turns: 3,
    events: trace(repeat(3, (i) => ['Read', { file_path: `src/${i}.ts` }])),
  },
  {
    name: 'repeated identical search, half the budget gone',
    shouldStop: true,
    spentUsd: 5.5, turns: 26,
    events: trace(repeat(12, () => ['Grep', { pattern: 'sessionToken' }])),
  },
  {
    name: 'repeated failing command, half the budget gone',
    shouldStop: true,
    spentUsd: 6, turns: 30,
    events: trace(repeat(10, () => ['Bash', { command: 'npm test' }, true])),
  },
  {
    name: 'hard budget breach on an otherwise healthy run',
    shouldStop: true,
    spentUsd: 10.5, turns: 12,
    events: trace([
      ['Edit', { file_path: 'src/a.ts' }], ['Bash', { command: 'npm test' }], ['Edit', { file_path: 'src/b.ts' }],
    ]),
  },
  {
    name: 'turn cap reached with no cost telemetry at all',
    shouldStop: true,
    spentUsd: 0, spendCapUsd: 0, turns: 60,
    events: trace([
      ['Edit', { file_path: 'src/a.ts' }], ['Bash', { command: 'npm test' }], ['Read', { file_path: 'src/b.ts' }],
    ]),
  },
  {
    name: 'unreadable trace, money mostly spent',
    shouldStop: false,
    spentUsd: 6, turns: 25,
    events: [{ type: 'assistant', payload: null }, {}],
  },
];

const SPEND_CAP = 10;
const SOFT_TARGET = 20;
const HARD_CAP = 60;

const rows = CASES.map((c) => {
  const signals = summarizeExecutionTrajectory(c.events);
  const guard = evaluateSpendGuard({
    spentUsd: c.spentUsd,
    spendCapUsd: c.spendCapUsd ?? SPEND_CAP,
    turns: c.turns,
    softTurnTarget: SOFT_TARGET,
    hardTurnCap: HARD_CAP,
    explorationSignal: signals.exploration,
    progressSignal: signals.progress,
    repeatedFailureSignal: signals.repeatedFailure,
  });
  const stopped = guard.state === 'STOP';
  return {
    name: c.name,
    exploration: signals.exploration.toFixed(2),
    progress: signals.progress.toFixed(2),
    state: guard.state,
    wanted: c.shouldStop ? 'STOP' : 'run on',
    verdict: stopped === c.shouldStop
      ? 'correct'
      : (stopped ? 'FALSE POSITIVE' : 'false negative'),
    reason: guard.reason ?? '',
  };
});

const columns = ['trajectory', 'explore', 'progress', 'guard', 'wanted', 'verdict'];
const table = rows.map((r) => [r.name, r.exploration, r.progress, r.state, r.wanted, r.verdict]);
const widths = columns.map((c, i) => Math.max(c.length, ...table.map((r) => String(r[i]).length)));
const line = (cells) => `| ${cells.map((cell, i) => String(cell).padEnd(widths[i])).join(' | ')} |`;

console.log(`\n## Spend guard against synthetic trajectories (cap $${SPEND_CAP}, soft ${SOFT_TARGET}, hard ${HARD_CAP})\n`);
console.log(line(columns));
console.log(`|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`);
for (const row of table) console.log(line(row));

console.log('\n### Why each stop happened\n');
for (const r of rows.filter((r) => r.state !== 'GREEN')) {
  console.log(`- **${r.name}** → ${r.state}: ${r.reason}`);
}

const falsePositives = rows.filter((r) => r.verdict === 'FALSE POSITIVE');
const falseNegatives = rows.filter((r) => r.verdict === 'false negative');

console.log(`\n### Mistakes\n`);
console.log(`- false positives (killed work that was going somewhere): ${falsePositives.length}`);
for (const r of falsePositives) console.log(`  - ${r.name}`);
console.log(`- false negatives (let a doomed run keep spending): ${falseNegatives.length}`);
for (const r of falseNegatives) console.log(`  - ${r.name}`);

console.log('\nNo model was called and no cluster was used. Re-run this file to reproduce every row.');

// A false positive is the mistake that costs an answer. It fails the run.
if (falsePositives.length > 0) process.exit(1);
