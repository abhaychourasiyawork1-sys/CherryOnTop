#!/usr/bin/env node
/** Per-task and overall comparison from analysis/records.jsonl. Prints markdown
 *  tables and writes analysis/summary.json. Medians, min/max and paired
 *  per-repetition differences only — no p-values (n = 2 per cell). */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(homedir(), 'Desktop', 'CherryOnTop-bench', 'analysis');
const recs = readFileSync(join(ROOT, 'records.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const tasks = [...new Set(recs.map((r) => r.task_id))].sort();
const med = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);
const f = (x, d = 3) => (x == null ? 'n/a' : Number(x).toFixed(d));
const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
const red = (b, c) => (b == null || c == null || b === 0 ? null : 1 - c / b);
const total = (r) => (r.input_tokens ?? 0) + (r.cache_read_tokens ?? 0) + (r.cache_creation_tokens ?? 0) + (r.output_tokens ?? 0);
const METRICS = {
  cost_usd: (r) => r.cost_usd, fresh_input: (r) => r.input_tokens, cache_read: (r) => r.cache_read_tokens, cache_creation: (r) => r.cache_creation_tokens,
  output: (r) => r.output_tokens, total_tokens: total, turns: (r) => r.num_turns, opening_visible: (r) => r.opening_visible_tokens,
  peak_visible: (r) => r.peak_visible_tokens, avg_visible: (r) => r.average_visible_tokens, tool_calls: (r) => r.tool_calls,
  exploration_before_edit: (r) => r.exploration_calls_before_first_edit, duplicate_calls: (r) => r.duplicate_tool_calls,
  repeat_file_reads: (r) => r.repeat_file_reads, repo_context: (r) => r.repo_context_tokens, evidence_tokens: (r) => r.evidence_tokens,
  wall_s: (r) => (r.end_to_end_ms == null ? null : r.end_to_end_ms / 1000), dispatches: (r) => r.dispatch_count, children: (r) => r.child_nodes,
};
const out = { tasks: {}, overall: {} };
const arm = (rs, a) => rs.filter((r) => r.arm === a).sort((x, y) => x.rep - y.rep);

for (const t of tasks) {
  const rs = recs.filter((r) => r.task_id === t);
  const B = arm(rs, 'baseline'), C = arm(rs, 'candidate');
  const entry = { instance: rs[0]?.instance_id, n: { baseline: B.length, candidate: C.length }, validated: { baseline: B.map((r) => r.validated), candidate: C.map((r) => r.validated) }, metrics: {} };
  for (const [name, fn] of Object.entries(METRICS)) {
    const b = B.map(fn), c = C.map(fn);
    entry.metrics[name] = { baseline: b, candidate: c, median_b: med(b), median_c: med(c), reduction_of_median: red(med(b), med(c)), paired: b.map((x, i) => (x == null || c[i] == null ? null : c[i] - x)) };
  }
  out.tasks[t] = entry;
}
// overall: totals across the 4 tasks x 2 reps per arm
for (const a of ['baseline', 'candidate']) {
  const rs = recs.filter((r) => r.arm === a);
  const ok = rs.filter((r) => r.validated === true);
  out.overall[a] = {
    runs: rs.length, validated_successes: ok.length, node_complete: rs.filter((r) => r.succeeded).length,
    total_cost: sum(rs.map((r) => r.cost_usd)), cost_per_validated_success: ok.length ? sum(rs.map((r) => r.cost_usd)) / ok.length : null,
    fresh_input: sum(rs.map((r) => r.input_tokens)), cache_read: sum(rs.map((r) => r.cache_read_tokens)), cache_creation: sum(rs.map((r) => r.cache_creation_tokens)),
    output: sum(rs.map((r) => r.output_tokens)), total_tokens: sum(rs.map(total)), turns: sum(rs.map((r) => r.num_turns)),
    retries: sum(rs.map((r) => r.retries)), fallbacks: sum(rs.map((r) => r.fallbacks)),
    reliability: Object.fromEntries(['transport_failure', 'timeout', 'model_rejection', 'rate_limited', 'max_turns', 'spend_cap', 'synthesis_failure', 'validation_failure'].map((k) => [k, rs.filter((r) => r.reliability?.[k]).length])),
  };
}
const ob = out.overall.baseline, oc = out.overall.candidate;
out.overall.reductions = {
  cost: red(ob.total_cost, oc.total_cost), fresh_input: red(ob.fresh_input, oc.fresh_input), cache_read: red(ob.cache_read, oc.cache_read),
  cache_creation: red(ob.cache_creation, oc.cache_creation), output: red(ob.output, oc.output), total_tokens: red(ob.total_tokens, oc.total_tokens), turns: red(ob.turns, oc.turns),
};
writeFileSync(join(ROOT, 'summary.json'), JSON.stringify(out, null, 1));

const line = (cells) => `| ${cells.join(' | ')} |`;
console.log('\n### Per-run');
console.log(line(['run', 'state', 'valid', 'cost $', 'fresh in', 'cache read', 'cache write', 'out', 'turns', 'open vis', 'peak vis', 'prompt tok', 'tools', 'dispatches', 'children']));
console.log(line(Array(15).fill('---')));
for (const r of [...recs].sort((a, b) => a.run_id.localeCompare(b.run_id))) {
  console.log(line([r.run_id, r.node_state, r.validated ?? 'n/a', f(r.cost_usd), r.input_tokens, r.cache_read_tokens, r.cache_creation_tokens, r.output_tokens, r.num_turns, r.opening_visible_tokens, r.peak_visible_tokens, r.prompt_tokens ?? 'n/a', r.tool_calls, r.dispatch_count, r.child_nodes]));
}
console.log('\n### Per-task (median of 2; [rep1, rep2] in brackets)');
console.log(line(['task', 'metric', 'baseline', 'candidate', 'candidate vs baseline (median)']));
console.log(line(Array(5).fill('---')));
for (const t of tasks) for (const m of ['cost_usd', 'fresh_input', 'cache_read', 'cache_creation', 'output', 'total_tokens', 'turns', 'opening_visible', 'peak_visible', 'tool_calls', 'exploration_before_edit', 'duplicate_calls', 'wall_s']) {
  const e = out.tasks[t].metrics[m];
  console.log(line([t, m, `${f(e.median_b, m === 'cost_usd' ? 3 : 0)} [${e.baseline.map((x) => f(x, m === 'cost_usd' ? 3 : 0)).join(', ')}]`, `${f(e.median_c, m === 'cost_usd' ? 3 : 0)} [${e.candidate.map((x) => f(x, m === 'cost_usd' ? 3 : 0)).join(', ')}]`, e.reduction_of_median == null ? 'n/a' : `${pct(e.reduction_of_median)} lower`]));
}
console.log('\n### Overall');
console.log(JSON.stringify(out.overall, null, 1));
