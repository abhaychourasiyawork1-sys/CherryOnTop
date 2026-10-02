// H2.6 analysis (bench/governor/h26/DESIGN.md §6–§7): collection from the
// preserved run databases, the primary outcome Y, and the final report.
// Offline only. The official grade is joined here and nowhere at runtime.
//
//   node bench/governor/h26/analysis.mjs <runsDir> [--phase main|pilot] [--look k]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = new URL('.', import.meta.url).pathname;
export const CONFIG = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Statistics (pure)
// ---------------------------------------------------------------------------

export const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
export const variance = (xs) => { const m = mean(xs); return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1); };
export const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q; const lo = Math.floor(pos); const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};
// erf: the Numerical Recipes erfc Chebyshev fit, |error| < 1.2e-7.
function erf(x) {
  const t = 1 / (1 + 0.5 * Math.abs(x));
  const y = 1 - t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806
    + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? y : -y;
}
export const Phi = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

/** Welch z of available − masked (§7). */
export function welch(a, m) {
  const se = Math.sqrt(variance(a) / a.length + variance(m) / m.length);
  return { diff: mean(a) - mean(m), se, z: (mean(a) - mean(m)) / se };
}

/** Deterministic PRNG for the pre-registered bootstraps (mulberry32). */
export function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function summary(xs) {
  return {
    n: xs.length, mean: mean(xs), sd: Math.sqrt(variance(xs)), median: quantile(xs, 0.5),
    p25: quantile(xs, 0.25), p75: quantile(xs, 0.75), p90: quantile(xs, 0.9), p95: quantile(xs, 0.95), p99: quantile(xs, 0.99),
    max: Math.max(...xs),
  };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** One analysis row per enrolled task (§6). `resolved` is the official grade,
 *  or null when the harness could not produce one after the re-grade rule.
 *  Y = C(b*→end) + 1[not resolved] · C(task); an ungraded task counts as
 *  unresolved (the conservative redo penalty). */
export function outcomeY(row) {
  return row.costAfterUsd + (row.resolved === true ? 0 : row.taskCostUsd);
}

export function priceUsd(usage, model, prices = CONFIG.priceSnapshotUsdPerMTok) {
  const family = /haiku/.test(model ?? 'haiku') ? 'haiku' : Object.keys(prices).find((k) => k !== 'source' && (model ?? '').includes(k));
  const p = prices[family ?? 'haiku'];
  return ((usage.inputTokens ?? 0) * p.input + (usage.outputTokens ?? 0) * p.output
    + (usage.cacheReadTokens ?? 0) * p.cacheRead + (usage.cacheCreationTokens ?? 0) * p.cacheWrite) / 1e6;
}

/** The experiment ledger's assignment rows (DESIGN.md §4): one file per bench
 *  root, shared by every run. */
export function readLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) return [];
  const Database = createRequire(import.meta.url)('better-sqlite3');
  const db = new Database(ledgerPath, { readonly: true });
  try { return db.prepare('select * from assignments order by rowid').all(); } finally { db.close(); }
}

/** Was recover carried out for the decision at b*? Only within that decision's
 *  own step: from the decision to the next step.outcome of the task. */
export function carriedInWindow(decision, events, tree) {
  if (!decision) return false;
  const chose = decision.payload.chosenCarriesRecover ?? decision.payload.chosenKind === 'recover';
  if (!chose) return false;
  if (events.some((e) => e.type === 'governor.intervention_carried' && e.payload.decisionId === decision.payload.decisionId)) return true;
  const end = events.find((e) => tree.has(e.nodeId) && e.type === 'step.outcome' && e.createdAt >= decision.createdAt)?.createdAt ?? '\uffff';
  return events.some((e) => tree.has(e.nodeId) && e.type === 'step.progress' && /pivoting rather than repeating/.test(e.payload?.message ?? '')
    && e.createdAt >= decision.createdAt && e.createdAt <= end);
}

/** Rows from one run directory's preserved database (+ grade.json), joined
 *  with the ledger's assignments for that run's tasks. */
export function collectRun(runDir, ledgerRows = readLedger(join(runDir, '..', '..', 'ledger.db'))) {
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  const db = new Database(join(runDir, 'state.db'), { readonly: true });
  try {
    const grade = existsSync(join(runDir, 'grade.json')) ? JSON.parse(readFileSync(join(runDir, 'grade.json'), 'utf8')) : null;
    const nodes = db.prepare('select id, parent_id as parentId from nodes').all();
    const usage = db.prepare("select node_id as nodeId, value, created_at as createdAt from memory where kind = 'dispatch_usage'").all()
      .map((r) => ({ ...r, value: JSON.parse(r.value) }));
    const events = db.prepare("select node_id as nodeId, type, payload, created_at as createdAt from events where type like 'experiment.%' or type in ('governor.intervention_carried', 'step.progress', 'economic.decision', 'dispatch.turn_budget', 'step.outcome') order by id").all()
      .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
    const nodeIds = new Set(nodes.map((n) => n.id));
    const assignments = ledgerRows.filter((a) => nodeIds.has(a.root_task_id));
    const subtree = (root) => { const ids = new Set([root]); let grew = true; while (grew) { grew = false; for (const n of nodes) if (n.parentId && ids.has(n.parentId) && !ids.has(n.id)) { ids.add(n.id); grew = true; } } return ids; };
    const rows = assignments.map((a) => {
      const rec = JSON.parse(a.record);
      const tree = subtree(a.root_task_id);
      const cost = (filter) => usage.filter((u) => tree.has(u.nodeId) && filter(u)).reduce((s, u) => s + priceUsd(u.value.usage, u.value.model), 0);
      // M* is the final choice at b*: System-1's refinement when it changed it.
      const atBstar = (role) => events.find((e) => e.type === 'experiment.boundary' && e.payload.role === role && e.payload.rootTaskId === a.root_task_id);
      const decision = atBstar('bstar_final_decision') ?? atBstar('bstar_decision');
      const pivots = events.filter((e) => tree.has(e.nodeId) && e.type === 'step.progress' && /pivoting rather than repeating/.test(e.payload?.message ?? ''));
      // Recover inside a composite counts (the decision logs chosenCarriesRecover).
      const carriedAtBstar = carriedInWindow(decision, events, tree);
      return {
        rootTaskId: a.root_task_id, phase: a.phase, Z: a.z, W: rec.W, recoverRank: rec.recoverRank,
        dispatchesToBstar: rec.completedDispatchesToBstar,
        chosenKind: decision?.payload.chosenKind ?? null, chosenCarriesRecover: decision?.payload.chosenCarriesRecover ?? null, substitute: decision?.payload.substitute ?? null,
        carriedAtBstar, laterRecover: pivots.length - (carriedAtBstar ? 1 : 0) > 0,
        costAfterUsd: cost((u) => u.createdAt > a.created_at), taskCostUsd: cost(() => true),
        // Final once graded, or once the harness has failed to grade it
        // CONFIG.regradeAttempts times (§6); only then may a look count it.
        resolved: grade && grade.resolved !== undefined ? Boolean(grade.resolved) : null,
        final: Boolean(grade && (grade.resolved !== undefined || (grade.attempts ?? 0) >= CONFIG.regradeAttempts)),
        assignedAt: a.created_at,
        interventionsPerTask: events.filter((e) => tree.has(e.nodeId) && e.type === 'governor.intervention_carried').length,
      };
    });
    const funnel = {
      governable: events.some((e) => e.type === 'economic.decision' && !(e.payload.reasonCodes ?? []).includes('ineligible:no_telemetry')),
      recoverCandidate: events.some((e) => e.type.startsWith('experiment.')),
      triggered: assignments.length > 0,
      d2: events.filter((e) => e.type === 'dispatch.turn_budget').map((e) => e.payload),
      firstDispatchTurns: usage.filter((u) => u.value.role === 'execute').sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1))[0]?.value.usage.numTurns ?? null,
      firstOutcome: events.find((e) => e.type === 'step.outcome')?.payload ?? null,
      writeFailures: events.filter((e) => e.type === 'experiment.write_failure').length,
      taskCostUsd: usage.reduce((s, u) => s + priceUsd(u.value.usage, u.value.model), 0),
    };
    return { rows, funnel, assignments: assignments.length };
  } finally { db.close(); }
}

export function collect(runsDir, ledgerPath = join(runsDir, '..', 'ledger.db')) {
  const ledger = readLedger(ledgerPath);
  const runs = readdirSync(runsDir).filter((d) => existsSync(join(runsDir, d, 'state.db')));
  return runs.map((r) => ({ run: r, ...collectRun(join(runsDir, r), ledger) }));
}

/** The data as it stood at scheduled look k (DESIGN.md §7). Looks 1–3: the
 *  enrollment-order prefix of main-phase rows at which min(n_a, n_m) first
 *  reached LOOKS[k-1], once every row in it is final. The final look: every
 *  enrolled main-phase row, once all are final. Null until then. */
export function lookPrefix(rows, k) {
  const looks = CONFIG.looks;
  const ordered = rows.filter((r) => r.phase === 'main').sort((a, b) => (a.assignedAt < b.assignedAt ? -1 : 1));
  const minArm = (rs) => Math.min(rs.filter((r) => r.Z === 'available').length, rs.filter((r) => r.Z === 'masked').length);
  let prefix = null;
  if (k === looks.length) {
    if (minArm(ordered) >= looks[k - 1]) prefix = ordered;
  } else {
    let na = 0; let nm = 0;
    for (let i = 0; i < ordered.length && !prefix; i++) {
      if (ordered[i].Z === 'available') na++; else nm++;
      if (Math.min(na, nm) >= looks[k - 1]) prefix = ordered.slice(0, i + 1);
    }
  }
  return prefix && prefix.every((r) => r.final) ? prefix : null;
}

// ---------------------------------------------------------------------------
// The report (§7 "Reported at the final analysis")
// ---------------------------------------------------------------------------

export function effect(rows, { boundary = null } = {}) {
  const a = rows.filter((r) => r.Z === 'available').map(outcomeY);
  const m = rows.filter((r) => r.Z === 'masked').map(outcomeY);
  if (a.length < 2 || m.length < 2) return { na: a.length, nm: m.length, estimate: null };
  const w = welch(a, m);
  return {
    na: a.length, nm: m.length, estimate: w.diff, se: w.se, z: w.z,
    ...(boundary === null
      ? { interval: [w.diff - 1.95996 * w.se, w.diff + 1.95996 * w.se], intervalKind: 'descriptive, not a test' }
      : { interval: [w.diff - boundary * w.se, w.diff + boundary * w.se], intervalKind: 'repeated-confidence' }),
  };
}

export function bootstrapCi(rows, resamples = 2000, seed = CONFIG.seeds.bootstrapCi) {
  const rand = prng(seed);
  const a = rows.filter((r) => r.Z === 'available').map(outcomeY);
  const m = rows.filter((r) => r.Z === 'masked').map(outcomeY);
  const draw = (xs) => mean(Array.from({ length: xs.length }, () => xs[Math.floor(rand() * xs.length)]));
  const diffs = Array.from({ length: resamples }, () => draw(a) - draw(m)).sort((x, y) => x - y);
  return [quantile(diffs, 0.025), quantile(diffs, 0.975)];
}

const rate = (xs) => (xs.length ? xs.filter(Boolean).length / xs.length : null);

/** Every reported quantity, at a scheduled look k (its boundary applies) or,
 *  with k = null, descriptively after an unscheduled stop. */
export function report(allRows, { look = null, phase = 'main' } = {}) {
  // At a scheduled look, exactly the data that look saw.
  const rows = look === null ? allRows.filter((r) => r.phase === phase) : lookPrefix(allRows, look);
  if (!rows) throw new Error(`look ${look} has not been reached`);
  const boundary = look === null ? null : CONFIG.efficacyBoundaries[look - 1];
  const arms = { available: rows.filter((r) => r.Z === 'available'), masked: rows.filter((r) => r.Z === 'masked') };
  const winsor = (() => {
    const ys = rows.map(outcomeY); const cap = quantile(ys, 0.99);
    const w = (rs) => rs.map((r) => Math.min(outcomeY(r), cap));
    return arms.available.length > 1 && arms.masked.length > 1 ? mean(w(arms.available)) - mean(w(arms.masked)) : null;
  })();
  return {
    phase, look, kind: look === null ? 'descriptive (unscheduled stop or not at a look)' : 'scheduled look',
    E1: { ...effect(rows, { boundary }), bootstrapCi: rows.length > 3 ? bootstrapCi(rows) : null, winsorized99: winsor,
      completeCase: effect(rows.filter((r) => r.resolved !== null), { boundary }).estimate },
    E1prime: { ...effect(rows.filter((r) => r.W === true), { boundary }), shareW: rate(rows.map((r) => r.W === true)) },
    substitution: { available: rate(arms.available.map((r) => r.substitute === true)), masked: rate(arms.masked.map((r) => r.substitute === true)),
      interventionsPerTask: { available: arms.available.length ? mean(arms.available.map((r) => r.interventionsPerTask)) : null,
        masked: arms.masked.length ? mean(arms.masked.map((r) => r.interventionsPerTask)) : null } },
    carryOut: { available: rate(arms.available.map((r) => r.carriedAtBstar)), availableW1: rate(arms.available.filter((r) => r.W).map((r) => r.carriedAtBstar)),
      maskedMustBeZero: arms.masked.filter((r) => r.carriedAtBstar).length,
      laterRecover: { available: rate(arms.available.map((r) => r.laterRecover)), masked: rate(arms.masked.map((r) => r.laterRecover)) },
      note: 'descriptive rates; never a divisor of E1' },
    safety: safety(rows),
    cost: Object.fromEntries(Object.entries(arms).map(([k, rs]) => [k, rs.length ? {
      Y: summary(rs.map(outcomeY)), redoShare: rate(rs.map((r) => r.resolved !== true)),
      costPerResolvedUsd: rs.filter((r) => r.resolved === true).length ? rs.reduce((s, r) => s + r.taskCostUsd, 0) / rs.filter((r) => r.resolved === true).length : null,
      missingGradeRate: rate(rs.map((r) => r.resolved === null)),
    } : null])),
    wording: 'E1 and E1′ are effects of recover availability at b*, not of executing recover.',
  };
}

export function safety(rows) {
  const a = rows.filter((r) => r.Z === 'available'); const m = rows.filter((r) => r.Z === 'masked');
  if (!a.length || !m.length) return null;
  const ra = a.filter((r) => r.resolved === true).length / a.length;
  const rm = m.filter((r) => r.resolved === true).length / m.length;
  const se = Math.sqrt(ra * (1 - ra) / a.length + rm * (1 - rm) / m.length);
  return { ra, rm, delta: ra - rm, z: se > 0 ? (ra - rm) / se : 0 };
}

if (process.argv[1] && process.argv[1].endsWith('analysis.mjs')) {
  const [dir, ...rest] = process.argv.slice(2);
  const opt = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  const rows = collect(dir).flatMap((r) => r.rows);
  const look = opt('--look', null);
  console.log(JSON.stringify(report(rows, { phase: opt('--phase', 'main'), look: look === null ? null : Number(look) }), null, 1));
}
