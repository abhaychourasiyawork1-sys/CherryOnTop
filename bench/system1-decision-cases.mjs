#!/usr/bin/env node
// The System-1 workload classes, and a decision-level check that runs them
// against a live Laya without running any agent.
//
// Two uses:
//
//  1. As fixtures. `WORKLOADS` names the seven workload classes the whole-harness
//     benchmark (bench/tier-b: Claude Code vs CherryOnTop + Laya) must cover, with
//     the decision shape each one is expected to produce. A whole-harness run that
//     skips a class cannot claim System-1 helped on it.
//
//  2. As a cheap, reproducible pre-check. `node bench/system1-decision-cases.mjs`
//     (after `npm run build`, with Laya reachable at ORG_LAYA_URL or on the default
//     supervised port) asks exactly the questions the runtime would ask for each
//     class, and prints the raw per-case rows: probability, verdict, whether the
//     question was asked at all, latency. No model tokens are spent. It measures
//     *decision quality and overhead*, not task outcome, and says so.
//
// Usage:
//   node bench/system1-decision-cases.mjs                 # table + raw JSONL on stdout
//   node bench/system1-decision-cases.mjs --out=file.jsonl
import { writeFileSync } from 'node:fs';

export const WORKLOADS = [
  {
    id: 'historical-coherent-review', class: 'historical coherent repo-wide investigation',
    goal: 'Review the codebase and check for bugs, no edits',
    expect: { split: false }, why: 'broad but one coherent investigation: the case that used to fan out five ways',
  },
  {
    id: 'single-file-change', class: 'single-file change',
    goal: 'Fix the off-by-one in src/utils/range.ts where the loop uses <= instead of <',
    expect: { split: false, asked: false }, why: 'economics would never delegate this, so System-1 must not even be asked',
  },
  {
    id: 'coherent-global-investigation', class: 'coherent global investigation',
    goal: 'Find out why the whole test suite became slow across every package after the last dependency upgrade',
    expect: { split: false }, why: 'one root cause to find, however many packages it spans',
  },
  {
    id: 'independent-workstreams', class: 'multiple independent workstreams',
    goal: 'Add input validation to the billing service, write a README for the auth package, and upgrade the logging library in the reporting service',
    expect: { split: true }, why: 'three unrelated deliverables in three places',
  },
  {
    id: 'ambiguous-implementation-choice', class: 'ambiguous implementation choice',
    goal: 'Make the configuration loader faster; it is slow on large config directories across all services',
    expect: {}, why: 'no fixed expectation; recorded so drift between runs is visible',
  },
  {
    id: 'validation-failure-recovery', class: 'validation failure requiring recovery',
    goal: 'The previous attempt to fix the flaky integration test failed validation; fix it properly',
    expect: { split: false }, why: 'recovery of one failed change is not a fan-out',
  },
  {
    id: 'model-initiated-decision', class: 'model-initiated decision request',
    goal: 'Speed up a slow static 50-item lookup table',
    frame: {
      type: 'choice', question: 'Which data structure is the better fit for a static 50-item lookup by key?',
      options: [{ id: 'A', description: 'a hash map keyed by id' }, { id: 'B', description: 'an unsorted linked list scanned linearly' }],
    },
    expect: { choice: 'A' }, why: 'a clear-cut choice: a wrong answer here is a provider problem, not a close call',
  },
];

const AUTHORITY = { budget_usd: 5, spawn_children: true, max_child_count: 4, tools: [] };

async function main() {
  const { system1Config } = await import('../dist/config/system1.js');
  const { createHttpProvider } = await import('../dist/system1/laya-client.js');
  const { createSystem1 } = await import('../dist/system1/guard.js');
  const { layaKey } = await import('../dist/system1/laya-process.js');
  const { assessDecomposability } = await import('../dist/system1/decomposability.js');
  const { createModelGateway } = await import('../dist/system1/model-gateway.js');
  const path = await import('node:path');
  const os = await import('node:os');

  const config = system1Config();
  const apiKey = config.apiKey ?? layaKey(path.join(os.homedir(), '.org'));
  const s1 = createSystem1(
    createHttpProvider({ name: config.mode === 'jev' ? 'jev' : 'laya', url: config.url, apiKey, timeoutMs: 30_000, model: 'typed-decisions' }),
    { maxCallsPerScope: 50, timeoutMs: 30_000 },
  );

  const rows = [];
  for (const w of WORKLOADS) {
    const started = Date.now();
    if (w.frame) {
      const gateway = createModelGateway({ system1: s1, scope: w.id, goal: w.goal, maxRequests: 1 });
      const reply = await gateway.handle([JSON.stringify(w.frame)]);
      const outcome = reply.records[0].outcome;
      const choice = outcome?.judgment?.result.selectedId ?? null;
      rows.push({
        id: w.id, class: w.class, asked: true, choice,
        probabilities: outcome?.judgment?.result.probabilities ?? null,
        latencyMs: outcome?.latencyMs ?? Date.now() - started,
        failure: outcome?.failure?.kind ?? null,
        matchesExpectation: w.expect.choice === undefined ? null : choice === w.expect.choice,
      });
      continue;
    }
    const r = await assessDecomposability({ scope: w.id, goal: w.goal, authority: AUTHORITY, existingChildren: 0 }, s1);
    const asked = r.outcome !== undefined;
    rows.push({
      id: w.id, class: w.class, asked, gate: r.gate ?? null,
      complexity: r.bundle.complexity,
      pDecomposable: r.outcome?.judgment?.result.probability ?? null,
      threshold: r.bundle.signals.system1_threshold ?? null,
      split: r.bundle.worthSplitting,
      latencyMs: r.outcome?.latencyMs ?? 0,
      failure: r.outcome?.failure?.kind ?? null,
      matchesExpectation: (w.expect.split === undefined || w.expect.split === r.bundle.worthSplitting)
        && (w.expect.asked === undefined || w.expect.asked === asked),
    });
  }

  console.log('\nSystem-1 decision cases (decision quality and overhead only, not task outcome)\n');
  for (const r of rows) {
    const verdict = r.choice !== undefined ? `choice=${r.choice}` : `split=${r.split}${r.asked ? ` p=${r.pDecomposable?.toFixed(3)} (threshold ${r.threshold})` : ` not asked (${r.gate})`}`;
    const mark = r.matchesExpectation === null ? '·' : r.matchesExpectation ? '✓' : '✗';
    console.log(`${mark} ${r.id.padEnd(34)} ${verdict.padEnd(46)} ${String(r.latencyMs).padStart(5)}ms${r.failure ? `  FAILED: ${r.failure}` : ''}`);
  }
  const judged = rows.filter((r) => r.matchesExpectation !== null);
  console.log(`\n${judged.filter((r) => r.matchesExpectation).length}/${judged.length} cases match their expected decision shape; raw rows follow.\n`);
  const jsonl = rows.map((r) => JSON.stringify(r)).join('\n');
  const out = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
  if (out) writeFileSync(out, `${jsonl}\n`);
  else console.log(jsonl);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
