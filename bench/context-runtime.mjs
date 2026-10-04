#!/usr/bin/env node
// Measures the context runtime against the assembly it replaced, with **no model
// calls and no cluster**. Run: `npm run bench:context` (builds first).
//
// Same discipline as bench/deterministic.mjs: it measures only what arithmetic
// decides — how many bytes and tokens reach the runtime, whether the argument
// limit is respected, what a budget keeps and what it drops, how much of a file
// a targeted read avoids, whether the cost model's quantiles are calibrated —
// and nothing that needs inference. What it cannot say is whether a smaller
// prompt still gets the task done; that is the paid matrix in bench/run.mjs, and
// this file does not pretend otherwise.
//
// `--write <path>` also saves the tables as markdown.
import { writeFileSync } from 'node:fs';
import { assembleExecutePrompt, assembleSynthesisPrompt, promptBudgetFromConfig } from '../dist/prompt/prompt-runtime.js';
import { buildRolePromptParts } from '../dist/prompts/roles.js';
import { buildSynthesisPrompt } from '../dist/intelligence/synthesize.js';
import { withRepoContext } from '../dist/intelligence/repo-map.js';
import { renderSessionMemory, MEMORY_LADDER } from '../dist/db/queries/sessions.js';
import { findSymbolBody } from '../dist/context/runtime/materializer.js';
import { estimateQuantiles, riskAdjusted, coverageOf } from '../dist/efficiency/execution-cost-model.js';
import { summarizeContextLedger, createDispatchLedger } from '../dist/observability/context-ledger.js';

const tokens = (text) => Math.ceil(text.length / 4);
const bytes = (text) => Buffer.byteLength(text, 'utf8');
const num = (value) => Math.round(value).toLocaleString('en-US');
const ARGV_LIMIT = 131_072; // MAX_ARG_STRLEN on Linux: one argument, in bytes.

const out = [];
const say = (line = '') => { out.push(line); console.log(line); };

function table(title, note, columns, rows) {
  say(`\n## ${title}\n`);
  if (note) say(`${note}\n`);
  const widths = columns.map((c, i) => Math.max(c.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => `| ${cells.map((cell, i) => String(cell).padEnd(widths[i])).join(' | ')} |`;
  say(line(columns));
  say(`|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`);
  for (const row of rows) say(line(row));
}

// Deterministic pseudo-random text and numbers: a benchmark whose inputs change
// between runs is not one.
function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}
const filler = (n, seed = 1) => {
  const r = prng(seed);
  const words = ['session', 'refresh', 'token', 'cart', 'total', 'discount', 'invoice', 'render', 'store', 'expire', 'fix', 'validate'];
  let text = '';
  while (text.length < n) text += `${words[Math.floor(r() * words.length)]} `;
  return text.slice(0, n);
};

// --------------------------------------------------------------------------
// The assembly this replaced, kept here as the reference.
// --------------------------------------------------------------------------
function legacyExecuteGoal({ goal, proofInstruction, preface, evidence, repoContext }) {
  const withHandoff = preface ? `${preface}\n\n${goal}` : goal;
  const withEvidence = evidence ? `${withHandoff}\n\n${evidence}` : withHandoff;
  return proofInstruction
    ? `${proofInstruction}\n\n${withEvidence}`
    : repoContext ? withRepoContext(withEvidence, repoContext) : withEvidence;
}

const role = buildRolePromptParts('execute', { reportsToParent: false });
const budget = promptBudgetFromConfig();

// --------------------------------------------------------------------------
// 1. Execute prompts across task sizes
// --------------------------------------------------------------------------
const evidenceFile = (n) => `Contents of src/big.ts (provided because finding it would have cost more than sending it):\n\`\`\`\n${filler(n, 3)}\n\`\`\``;
const scenarios = [
  { name: 'tiny (typo)', goal: 'Fix the typo in README.md', repoContext: null },
  { name: 'small (single file)', goal: 'Fix the off-by-one in src/cart/checkout.ts. '.padEnd(600, 'x'), repoContext: filler(8_000, 2) },
  { name: 'medium (multi-file)', goal: filler(4_000, 5), repoContext: filler(20_000, 2), evidence: evidenceFile(12_000), preface: 'Budget: $1.00. You have at most 60 turns.' },
  { name: 'large (repo-wide issue)', goal: filler(30_000, 6), repoContext: filler(24_000, 2), evidence: evidenceFile(60_000), preface: filler(24_000, 7) },
  { name: 'evidence-heavy', goal: filler(2_000, 8), repoContext: filler(24_000, 2), evidence: evidenceFile(64_000), preface: filler(20_000, 7) },
  { name: 'retry (proof pass)', goal: filler(3_000, 9), proofInstruction: 'Your change is already in place; prove it.', repoContext: null, preface: 'Budget: $1.00.' },
];

const rows1 = scenarios.map((s) => {
  const legacy = legacyExecuteGoal(s);
  const compiled = assembleExecutePrompt({
    role, goal: s.goal, proofInstruction: s.proofInstruction, repoContext: s.repoContext,
    ...(s.evidence ? { evidence: s.evidence } : {}), ...(s.preface ? { preface: s.preface } : {}),
  }, budget);
  const same = compiled.goal === legacy;
  return [
    s.name, num(bytes(legacy)), bytes(legacy) > ARGV_LIMIT ? 'E2BIG' : 'ok',
    num(bytes(compiled.goal)), bytes(compiled.goal) > ARGV_LIMIT ? 'E2BIG' : 'ok',
    compiled.receipt?.status ?? 'fallback', same ? 'identical' : `${compiled.receipt.dropped.length} dropped, ${compiled.receipt.demoted.length} demoted`,
    compiled.goal.includes(s.goal.slice(0, 200)) ? 'yes' : 'NO',
  ];
});
table('Execute prompt: the hand-built assembly against the compiled one',
  `One ${num(ARGV_LIMIT)}-byte argument is the kernel's limit; the compiler's ceiling is ${num(budget.maxBytesPerChannel)}. "identical" means byte-for-byte the old prompt: nothing changes until something is too big.`,
  ['scenario', 'legacy bytes', 'legacy', 'compiled bytes', 'compiled', 'status', 'vs legacy', 'goal kept'], rows1);

// --------------------------------------------------------------------------
// 2. Synthesis fan-in
// --------------------------------------------------------------------------
const report = (i, n = 13_000) => `${i}: ${filler(n, 20 + i)}`;
const rows2 = [2, 3, 6, 11, 20, 40].map((n) => {
  const children = Array.from({ length: n }, (_, i) => ({ goal: `piece ${i + 1}`, succeeded: true, report: report(i + 1) }));
  const legacy = buildSynthesisPrompt('review everything', children);
  const compiled = assembleSynthesisPrompt({ goal: 'review everything', children, role: buildRolePromptParts('synthesize') }, budget);
  const levels = compiled.receipt ? compiled.receipt.blocks.filter((b) => b.kind === 'child-report').map((b) => b.level) : [];
  return [
    n, num(bytes(legacy)), bytes(legacy) > ARGV_LIMIT ? 'E2BIG — synthesis lost' : 'ok',
    compiled.refused ? 'refused (reports stand)' : num(bytes(compiled.goal)),
    compiled.refused ? '-' : bytes(compiled.goal) > ARGV_LIMIT ? 'E2BIG' : 'ok',
    levels.length ? `${Math.min(...levels)}–${Math.max(...levels)}` : '-',
  ];
});
table('Synthesis prompt: n children, each reporting 13,000 characters',
  'Each report was clipped to 12,000 characters on its own and all were concatenated, so past ten children the argument overflowed. Compiled together they share one ceiling, and the loss is shared: the last column is the range of demotion levels across children (0 = untouched).',
  ['children', 'legacy bytes', 'legacy', 'compiled bytes', 'compiled', 'demotion range'], rows2);

// --------------------------------------------------------------------------
// 3. Long-horizon conversation
// --------------------------------------------------------------------------
const turns = (n) => Array.from({ length: n }, (_, i) => ({
  nodeId: `n${i}`, request: `Request ${i + 1}: ${filler(300, 40 + i)}`, state: 'COMPLETE',
  answer: `Answer ${i + 1}: ${filler(4_000, 60 + i)}`, files: [`src/f${i}.ts`],
}));
const rows3 = [3, 10, 30, 60, 300].flatMap((n) => {
  const t = turns(n);
  return MEMORY_LADDER.map((rung, level) => {
    const text = renderSessionMemory(t, rung);
    return [
      n, level, num(text.length), num(tokens(text)),
      text.includes('Request 1:') ? 'yes' : 'NO', text.includes(`Request ${n}:`) ? 'yes' : 'NO',
    ];
  });
});
table('Chat session memory at each rung of the ladder',
  'The first turn (it states the task) and the newest turn (what "it" and "again" refer to) survive every rung; the middle is compressed to one line per turn. Rung 0 is the budget the runtime has always used.',
  ['turns', 'rung', 'chars', 'tokens', 'first turn', 'newest turn'], rows3);

// --------------------------------------------------------------------------
// 4. Targeted evidence
// --------------------------------------------------------------------------
function sourceFile(functions, linesEach) {
  const parts = [];
  for (let f = 0; f < functions; f++) {
    parts.push(`/** Does thing ${f}. */`, `export function thing${f}(input: string) {`);
    for (let l = 0; l < linesEach; l++) parts.push(`  const step${l} = input.length + ${l}; // ${filler(30, f * 100 + l)}`);
    parts.push('  return input;', '}', '');
  }
  return parts.join('\n');
}
const rows4 = [[4, 20], [12, 30], [30, 40], [60, 25]].map(([f, l]) => {
  const src = sourceFile(f, l);
  const wanted = `thing${Math.floor(f / 2)}`;
  const excerpt = findSymbolBody(src, wanted);
  return [
    `${f} functions × ${l} lines`, num(tokens(src)),
    excerpt ? num(tokens(excerpt.text)) : 'n/a', excerpt ? `${(100 * (1 - tokens(excerpt.text) / tokens(src))).toFixed(0)}%` : '-',
    excerpt ? `${excerpt.from}-${excerpt.to} of ${excerpt.totalLines}` : '-',
  ];
});
table('Targeted evidence: one named function against the whole file',
  'Tokens sent when the goal names one declaration. The whole file is the escalation when the declaration cannot be delimited.',
  ['file', 'whole file tokens', 'excerpt tokens', 'saved', 'lines'], rows4);

// --------------------------------------------------------------------------
// 5. Sibling prefix sharing
// --------------------------------------------------------------------------
const siblingRepo = filler(12_000, 2);
const sib = (i) => assembleExecutePrompt({
  role, goal: `Piece ${i}: ${filler(500, 90 + i)}`, repoContext: siblingRepo, preface: 'Budget: $0.30. You have at most 60 turns.',
}, budget);
const siblings = [1, 2, 3, 4, 5].map(sib);
const fingerprints = new Set(siblings.map((s) => s.receipt.cache.stable));
const sessions = new Set(siblings.map((s) => s.receipt.cache.session));
const prefixTokens = tokens(siblings[0].goal.slice(0, siblings[0].receipt.cache.boundary.user));
table('Five sibling dispatches on one commit',
  'Stable = fingerprint of role and repository context; session adds the handoff. One value means the leading bytes are identical and a prefix cache can serve them; the goal, which differs, is last.',
  ['siblings', 'distinct stable prefixes', 'distinct session prefixes', 'shared prefix tokens', 'share of one prompt'],
  [[5, fingerprints.size, sessions.size, num(prefixTokens), `${(100 * prefixTokens / tokens(siblings[0].goal)).toFixed(0)}%`]]);

// --------------------------------------------------------------------------
// 6. Cost model calibration (synthetic, seeded)
// --------------------------------------------------------------------------
{
  const r = prng(7);
  const draw = (scale) => { // log-normal-ish: heavy right tail
    const u = Math.max(1e-6, r()); const v = r();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.round(scale * Math.exp(0.6 * z));
  };
  const rowsC = [];
  for (const n of [8, 20, 60, 200]) {
    const train = Array.from({ length: n }, () => ({ role: 'execute', model: 'sonnet', tokens: draw(40_000) }));
    const test = Array.from({ length: 2_000 }, () => draw(40_000));
    const q = estimateQuantiles(train, { role: 'execute', model: 'sonnet' });
    if (!q) { rowsC.push([n, 'cold start (prior kept)', '-', '-', '-', '-']); continue; }
    const mean = train.reduce((s, x) => s + x.tokens, 0) / n;
    const cover = coverageOf(test.map((actual) => ({ predicted: q, actual })));
    const meanCover = test.filter((a) => a <= mean).length / test.length;
    rowsC.push([n, 'quantiles', cover.p50.toFixed(2), cover.p75.toFixed(2), cover.p90.toFixed(2), `${meanCover.toFixed(2)} (mean)`]);
  }
  table('Cost model calibration on a synthetic heavy-tailed history',
    'Share of 2,000 held-out dispatches at or under each prediction. A calibrated model reads 0.50 / 0.75 / 0.90. A mean sits wherever the skew puts it. Synthetic: it checks the estimator, not the world.',
    ['history size', 'estimate', 'covers p50', 'covers p75', 'covers p90', 'mean covers'], rowsC);
}

// --------------------------------------------------------------------------
// 7. The ledger, over the runs above
// --------------------------------------------------------------------------
{
  const ledger = createDispatchLedger({ taskId: 't', nodeId: 'n', dispatchId: 'n/execute/bench' });
  for (const s of siblings) ledger.recordCompile(s.receipt);
  ledger.record('materialize', { tokens: 250, representation: 'symbol' });
  ledger.record('materialize', { tokens: 1_900, representation: 'full' });
  const summary = summarizeContextLedger(ledger.records());
  table('Context ledger over the sibling runs', 'What a trace lets a benchmark ask.',
    ['dispatch records', 'prompt tokens (all)', 'by kind', 'targeted rate', 'whole-file rate', 'distinct stable prefixes'],
    [[ledger.records().length, num(summary.tokensByPhase.compile ?? 0),
      Object.entries(summary.promptTokensByKind).map(([k, v]) => `${k}:${num(v)}`).join(' '),
      summary.acquisitions.targetedRate.toFixed(2), summary.acquisitions.wholeFileRate.toFixed(2), summary.distinctStablePrefixes]]);
}

const target = process.argv.indexOf('--write');
if (target !== -1 && process.argv[target + 1]) {
  writeFileSync(process.argv[target + 1], `# Context runtime — deterministic benchmark\n\nGenerated by \`npm run bench:context\`; no model calls.\n${out.join('\n')}\n`);
}
