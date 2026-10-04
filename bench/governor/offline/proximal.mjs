// H2.6 research: intervention-proximal outcomes and identification strategies.
// Offline only; no runtime policy changes.
//
// Every outcome is computed from runtime-visible signals (the economic state
// and the event snapshot production derives from its events table) over the
// k steps after a boundary. Its *true* effect is known here and only here: a
// masked re-run with the same random draws (CRN) differs from the base run
// only in that one intervention not being carried out. That truth is used to
// grade outcomes and estimators, never as an input to any of them.
//   node bench/governor/offline/proximal.mjs → offline/results/proximal.json
import { writeFileSync } from 'node:fs';
import { runTask, hashUnit } from '../sim.mjs';
import { taskSet, cfg } from './evaluate.mjs';
import { regimeOf, featuresOf, createBaseline } from './learned-value.mjs';
import { isExecutable } from '../../../dist/lifecycle/executable.js';
import { redoProbability, stateValue } from '../../../dist/decision/utility.js';

const KS = [3, 5, 10];
const PRICE = cfg.usdPerToken;
const V_SCORE = { passed: 1, pending: 0.5, unknown: 0.25, failed: 0 };

// ---------------------------------------------------------------------------
// One traced run
// ---------------------------------------------------------------------------

function traced(task, opts) {
  const steps = new Map(); const boundaries = [];
  const run = runTask(task, cfg, {
    ...opts,
    observeStep: ({ state, snapshot }) => steps.set(state.version, {
      consumed: state.resources.consumedTokens, budget: state.resources.totalTokenBudget,
      productive: snapshot.productiveActions, vStatus: state.validation.status, sim: state.trajectory.stateSimilarity,
      fp: state.trajectory.failurePressure, p: redoProbability(state), V: stateValue(state).tokens,
      targets: new Set([...snapshot.activeTargets, ...snapshot.searchTargets, ...snapshot.failureSignatures]),
      regime: regimeOf(state), x: featuresOf(state),
    }),
    observe: ({ state, decision }) => {
      // The best executable intervention the market priced here, and its
      // margin over continue (positive = the market prefers it).
      const cont = decision.candidates.find((c) => c.kind === 'continue');
      const alt = decision.candidates.filter((c) => c.status !== 'rejected' && c.kind !== 'continue' && c.kind !== 'stop')
        .sort((a, b) => a.conservativeCostUsd - b.conservativeCostUsd)[0];
      boundaries.push({ version: state.version, chosen: decision.action.kind,
        alt: alt ? { kind: alt.kind, margin: cont ? (cont.conservativeCostUsd - alt.conservativeCostUsd) / PRICE / state.resources.totalTokenBudget : 0 } : null });
    },
  });
  const end = { version: run.w.step, validated: run.w.outcome.validated, succeeded: run.w.outcome.succeeded, tokens: run.w.tokens };
  return { run, steps, boundaries, end };
}

/** Every candidate outcome at boundary t, oriented so that higher is better. */
function outcomes(tr, t) {
  const s0 = tr.steps.get(t); if (!s0) return null;
  const { end } = tr;
  const out = {};
  const ctg = ((end.tokens - s0.consumed) + (end.validated ? 0 : end.tokens)) / s0.budget;
  out.ctg = -ctg;
  for (const k of KS) {
    const tk = t + k; const s = tr.steps.get(tk); const done = !s; // the run ended before t+k
    const last = done ? (tr.steps.get(end.version) ?? [...tr.steps.values()].at(-1)) : s;
    const productive = done ? last.productive + (end.validated ? tk - end.version : 0) : s.productive;
    out[`progress@${k}`] = (productive - s0.productive) / k;
    out[`validation@${k}`] = (done ? (end.validated ? 1 : 0) : V_SCORE[s.vStatus]) - V_SCORE[s0.vStatus];
    if (s0.vStatus === 'failed') {
      let resolved = 0;
      for (let v = t + 1; v <= tk; v++) { const x = tr.steps.get(v); if (x ? x.vStatus !== 'failed' : end.validated) { resolved = 1; break; } if (!x) break; }
      out[`resolve@${k}`] = resolved;
    }
    let sims = 0; let n = 0;
    for (let v = t + 1; v <= tk; v++) { const x = tr.steps.get(v); sims += x ? x.sim : 0; n++; }
    out[`loopbreak@${k}`] = -(sims / n);
    out[`risk@${k}`] = s0.p - (done ? (end.validated ? 0 : 1) : s.p);
    const td = done ? ((end.tokens - s0.consumed) + (end.validated ? 0 : end.tokens)) : (s.consumed - s0.consumed + s.V);
    out[`td@${k}`] = -td / s0.budget;
    const a = s0.targets; const b = last.targets;
    const inter = [...a].filter((x) => b.has(x)).length; const uni = new Set([...a, ...b]).size;
    out[`change@${k}`] = uni ? 1 - inter / uni : 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Data: H2.5 runs, every carried intervention CRN-masked; plus withhold-only
// randomized exploration runs.
// ---------------------------------------------------------------------------

const tasks = taskSet();
const ivs = [];      // per carried intervention: outcomes carried vs masked, oracle saving
const obs = [];      // per evaluated boundary (observational data a runtime would have)
const randomized = {}; // ε → { rows, runs }
const coin = (task, rep, v, salt) => hashUnit('explore', salt, task.id, rep, v);

for (let rep = 0; rep < 3; rep++) {
  const history = new Map();
  tasks.forEach((task, index) => {
    const opts = { variant: 'H2', rep, regime: 'M1', history, executable: isExecutable, gate: (v) => v.decision.action };
    const base = traced(task, opts);
    const carriedAt = new Map(base.run.w.interventions.map((i) => [i.version, i]));
    for (const b of base.boundaries) {
      const y = outcomes(base, b.version); if (!y) continue;
      const iv = carriedAt.get(b.version);
      const st = base.steps.get(b.version);
      obs.push({ index, rep, kind: iv ? iv.kind : 'continue', alt: b.alt, y, regime: st.regime, x: st.x, validated: base.end.validated, succeeded: base.end.succeeded });
    }
    for (const iv of base.run.w.interventions) {
      const masked = traced(task, { ...opts, mask: iv.index });
      const y1 = outcomes(base, iv.version); const y0 = outcomes(masked, iv.version);
      if (!y1 || !y0) continue;
      const b0 = base.steps.get(iv.version);
      const saving = ((masked.end.tokens - base.end.tokens) + ((base.end.succeeded ? 1 : 0) - (masked.end.succeeded ? 1 : 0)) * task.steps * task.tps) / b0.budget;
      const m0 = masked.steps.get(iv.version);
      ivs.push({ index, rep, kind: iv.kind, y1, y0, saving, regime: b0.regime, aligned: !!m0 && m0.consumed === b0.consumed && m0.productive === b0.productive });
    }
    if (base.run.w.outcome.validated) history.set(task.repo, (history.get(task.repo) ?? 0) + 1);
  });
}

// Withhold-only exploration: where the market chose an intervention, a
// runtime coin withholds it (the agent simply continues) with probability ε.
// It never forces anything the market did not choose.
for (const eps of [0.1, 0.25, 0.5]) {
  const rows = []; const runs = [];
  for (let rep = 0; rep < 3; rep++) {
    const history = new Map();
    tasks.forEach((task, index) => {
      const draws = new Map();
      const opts = { variant: 'H2', rep, regime: 'M1', history, executable: isExecutable,
        gate: (v) => { const u = coin(task, rep, v.state.version, eps); const withhold = u < eps; draws.set(v.state.version, { kind: v.decision.action.kind, withhold }); return withhold ? null : v.decision.action; } };
      const tr = traced(task, opts);
      for (const [version, d] of draws) { const y = outcomes(tr, version); if (y) rows.push({ index, rep, ...d, y }); }
      runs.push({ taskId: task.id, index, rep, tokens: tr.end.tokens, success: tr.end.succeeded });
      if (tr.end.validated) history.set(task.repo, (history.get(task.repo) ?? 0) + 1);
    });
  }
  randomized[eps] = { rows, runs };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const corr = (a, b) => { const ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return da && db ? n / Math.sqrt(da * db) : null; };
const auc = (score, label) => { const p = [], n = []; score.forEach((s, i) => (label[i] ? p : n).push(s)); if (!p.length || !n.length) return null; let w = 0; for (const a of p) for (const b of n) w += a > b ? 1 : a === b ? 0.5 : 0; return w / (p.length * n.length); };
const se = (xs) => sd(xs) / Math.sqrt(Math.max(1, xs.length));

const OUTS = ['ctg', ...KS.flatMap((k) => ['progress', 'validation', 'resolve', 'loopbreak', 'risk', 'td', 'change'].map((o) => `${o}@${k}`))];
const KINDS = ['acquire_evidence', 'recover'];

// State-adjusted observational: residualize each outcome on runtime features,
// fitted on all observational boundaries (no outcome of the effect's own
// counterfactual is used).
const residual = {};
for (const o of OUTS) {
  const rows = obs.filter((r) => r.y[o] !== undefined);
  const m = createBaseline(rows[0]?.x.length ?? 9); for (const r of rows) m.add(r.x, r.y[o]);
  residual[o] = new Map(rows.map((r) => [r, r.y[o] - m.predict(r.x)]));
}
/** Treated mean minus continue mean, matched on regime cells (A), optionally
 *  on the residual (B). */
function observational(kind, o, adjusted) {
  const val = (r) => (adjusted ? residual[o].get(r) : r.y[o]);
  const treated = obs.filter((r) => r.kind === kind && r.y[o] !== undefined);
  const cells = new Map();
  for (const r of obs) if (r.y[o] !== undefined) { const key = `${r.regime.regime}|${r.regime.phase}`; const c = cells.get(key) ?? { t: [], c: [] }; (r.kind === kind ? c.t : r.kind === 'continue' ? c.c : []).push(val(r)); cells.set(key, c); }
  let num = 0, w = 0;
  for (const c of cells.values()) if (c.t.length && c.c.length) { num += c.t.length * (mean(c.t) - mean(c.c)); w += c.t.length; }
  return w ? { estimate: num / w, n: treated.length, coverage: w / Math.max(1, treated.length) } : null;
}
/** Regression discontinuity on the market's own margin: boundaries where the
 *  best executable intervention barely won against barely lost. */
function rdd(kind, o, h) {
  const near = obs.filter((r) => r.alt && r.alt.kind === kind && Math.abs(r.alt.margin) < h && r.y[o] !== undefined);
  const right = near.filter((r) => r.alt.margin > 0 && r.kind === kind).map((r) => r.y[o]);
  const left = near.filter((r) => r.alt.margin <= 0 && r.kind === 'continue').map((r) => r.y[o]);
  return right.length && left.length ? { estimate: mean(right) - mean(left), se: Math.hypot(se(right), se(left)), n: [right.length, left.length] } : null;
}
function randomizedEstimate(eps, kind, o) {
  const rows = randomized[eps].rows.filter((r) => r.kind === kind && r.y[o] !== undefined);
  const t = rows.filter((r) => !r.withhold).map((r) => r.y[o]); const c = rows.filter((r) => r.withhold).map((r) => r.y[o]);
  return t.length && c.length ? { estimate: mean(t) - mean(c), se: Math.hypot(se(t), se(c)), n: [t.length, c.length] } : null;
}

const study = {};
for (const kind of KINDS) {
  study[kind] = {};
  const rows = ivs.filter((r) => r.kind === kind);
  for (const o of OUTS) {
    const pairs = rows.filter((r) => r.y1[o] !== undefined && r.y0[o] !== undefined);
    if (pairs.length < 5) continue;
    const delta = pairs.map((r) => r.y1[o] - r.y0[o]);
    const pooled = [...pairs.map((r) => r.y1[o]), ...pairs.map((r) => r.y0[o])];
    const effect = mean(delta); const sdY = sd(pooled);
    const d = sdY > 0 ? Math.abs(effect) / sdY : 0;
    const surrogate = corr(delta, pairs.map((r) => r.saving));
    const obsRows = obs.filter((r) => r.y[o] !== undefined);
    const A = observational(kind, o, false); const B = observational(kind, o, true);
    study[kind][o] = {
      n: pairs.length, trueEffect: effect, effectSE: se(delta), sdY, standardizedEffect: d,
      perArmForTwoSE: d > 0 ? Math.ceil(8 / (d * d)) : null,
      // Does the proxy's effect move with the whole-task effect, intervention by intervention?
      surrogateCorr: surrogate,
      signAgreesWithTaskEffect: Math.sign(effect) === Math.sign(mean(pairs.map((r) => r.saving))),
      // Observational relationship with eventual outcome.
      aucValidated: auc(obsRows.map((r) => r.y[o]), obsRows.map((r) => r.validated)),
      aucTrueSuccessOffline: auc(obsRows.map((r) => r.y[o]), obsRows.map((r) => r.succeeded)),
      A_observational: A && { ...A, bias: A.estimate - effect },
      B_stateAdjusted: B && { ...B, bias: B.estimate - effect },
      D_rdd: Object.fromEntries([0.0005, 0.002, 0.01, 0.05].map((h) => [h, rdd(kind, o, h)])),
      // CUPED-style: share of outcome variance pre-treatment state explains.
      // On randomized data, adjusting by it stays unbiased and divides the
      // required sample by 1/(1 − R²).
      r2: (() => { const rs = obsRows.filter((r) => residual[o].has(r)); const v = sd(rs.map((r) => r.y[o])) ** 2; return v > 0 ? 1 - sd(rs.map((r) => residual[o].get(r))) ** 2 / v : null; })(),
      C_randomized: Object.fromEntries(Object.keys(randomized).map((eps) => { const r = randomizedEstimate(eps, kind, o); return [eps, r && { ...r, bias: r.estimate - effect, zOfTruth: r.se ? (r.estimate - effect) / r.se : null }]; })),
    };
  }
}
// What exploration costs: CPS and success of each ε against ε = 0 (H2.5).
const cps = (runs) => runs.reduce((s, r) => s + r.tokens, 0) / Math.max(1, runs.filter((r) => r.success).length);
const base = []; // H2.5 runs, for the exploration-cost comparison
for (let rep = 0; rep < 3; rep++) { const history = new Map(); tasks.forEach((task, index) => { const r = runTask(task, cfg, { variant: 'H2', rep, regime: 'M1', history, executable: isExecutable }); base.push({ index, rep, tokens: r.w.tokens, success: r.w.outcome.succeeded }); if (r.w.outcome.validated) history.set(task.repo, (history.get(task.repo) ?? 0) + 1); }); }
const explorationCost = Object.fromEntries(Object.entries(randomized).map(([eps, { runs, rows }]) => [eps, {
  cpsVsH25: cps(runs) / cps(base) - 1, successVsH25: mean(runs.map((r) => +r.success)) - mean(base.map((r) => +r.success)),
  randomizedDecisionsPerTask: rows.length / runs.length, withheldPerTask: rows.filter((r) => r.withhold).length / runs.length,
}]));
const margins = obs.filter((r) => r.alt).map((r) => r.alt.margin).sort((a, b) => a - b);
const marginQuantiles = [0.05, 0.25, 0.5, 0.75, 0.95].map((q) => margins[Math.floor(q * (margins.length - 1))]);
const counts = { marginQuantiles, interventions: ivs.length, byKind: Object.fromEntries(KINDS.map((k) => [k, ivs.filter((r) => r.kind === k).length])), boundaries: obs.length, tasksPerStream: tasks.length, streams: 3,
  // CRN check: at the intervention's boundary the masked run must be identical.
  alignedAtBoundary: ivs.filter((r) => r.aligned).length / Math.max(1, ivs.length) };
writeFileSync(new URL('./results/proximal.json', import.meta.url).pathname, JSON.stringify({ counts, explorationCost, study }, null, 1));
console.log(JSON.stringify({ counts, explorationCost }, null, 1));
