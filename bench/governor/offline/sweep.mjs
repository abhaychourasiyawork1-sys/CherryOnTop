// H2.5 offline threshold sweeps over Pass B (120 tasks × 3 reps, CRN-paired).
// Thresholds are chosen on the fit window (chronological tasks 1–72) and
// confirmed on the held-out window (73–120).
//   node bench/governor/offline/sweep.mjs   → bench/governor/offline/results/
import { mkdirSync, writeFileSync } from 'node:fs';
import { taskSet, runConfig, metrics, pareto, pairedDelta, scoresOf } from './evaluate.mjs';
import { runTask } from '../sim.mjs';
import { cfg } from './evaluate.mjs';

const OUT = new URL('./results/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const tasks = taskSet();
const FIT = (r) => r.index < 72;
const HELD = (r) => r.index >= 72;
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

const all = [];
function run(name, family, conf) {
  const runs = runConfig(conf, tasks);
  const entry = { name, family, conf, runs, fit: metrics(runs, FIT), held: metrics(runs, HELD), allM: metrics(runs) };
  all.push(entry);
  log(`${name}: fit succ ${(entry.fit.success * 100).toFixed(1)}% tps ${(entry.fit.tokensPerSuccess / 1e3).toFixed(1)}k iv/task ${entry.fit.interventionsPerTask.toFixed(2)}`);
  return entry;
}

// ---- baselines -------------------------------------------------------------
const H0 = run('H0', 'baseline', { variant: 'H0' });
const H2 = run('H2', 'baseline', { variant: 'H2' });
run('H3b', 'baseline', { variant: 'H3b' });
const H4 = run('H4', 'baseline', { variant: 'H4' });

// ---- score distributions of what the market selects (fit window, H2) -------
const scores = [];
for (const [index, task] of tasks.entries()) {
  if (index >= 72) continue;
  for (let rep = 0; rep < 3; rep++) {
    runTask(task, cfg, { variant: 'H2', rep, regime: 'M1', gate: (view) => {
      const c = view.considered.find((x) => x.id === view.decision.action.id);
      const s = view.decision.candidates.find((x) => x.id === view.decision.action.id);
      if (c && s) scores.push({ kind: c.kind, id: c.id.split(':')[0], ...scoresOf(c, s, view) });
      return view.decision.action;
    } });
  }
}
const quant = (key, filter = () => true) => {
  const xs = scores.filter(filter).map((s) => s[key]).filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  return [0.1, 0.25, 0.5, 0.75, 0.9].map((p) => xs[Math.floor(p * (xs.length - 1))]);
};
const grids = {
  intervention: quant('roi'), preventability: quant('prevention'), riskOnly: quant('pFail'),
  decisionChange: quant('dcValueRatio', (s) => s.info), infoGain: quant('infoGain', (s) => s.info),
};
const byKind = {};
for (const s of scores) {
  const k = `${s.id}/${s.kind}`;
  byKind[k] ??= { n: 0, roi: 0, prevention: 0, pFail: 0, pPrev: 0, pSucc: 0 };
  const b = byKind[k]; b.n += 1; for (const f of ['roi', 'prevention', 'pFail', 'pPrev', 'pSucc']) b[f] += s[f];
}
for (const b of Object.values(byKind)) for (const f of ['roi', 'prevention', 'pFail', 'pPrev', 'pSucc']) b[f] /= b.n;
log(`grids ${JSON.stringify(grids)}`);

// ---- boundary sweeps on H2 -------------------------------------------------
for (const [key, grid] of Object.entries(grids)) {
  for (const [i, q] of grid.entries()) run(`H2 ${key}≥q${[10, 25, 50, 75, 90][i]}`, key, { variant: 'H2', gate: { [key]: q } });
  run(`H2 ${key}=off`, key, { variant: 'H2', gate: { [key]: Infinity } });
}

// ---- discovery margin on H3b ------------------------------------------------
for (const m of [2, 4, 8, 16, 64, 1e12]) run(`H3b discovery×${m >= 1e12 ? '∞' : m}`, 'discovery', { variant: 'H3b', discovery: m });

// ---- replay on H4 -----------------------------------------------------------
run('H4 replay≤1', 'replay', { variant: 'H4', replay: { mode: 'as_is', maxReplays: 1 } });
for (const theta of [0.1, 0.3, 1, 3]) run(`H4 replay gated θ${theta} ≤1`, 'replay', { variant: 'H4', replay: { mode: 'gated', theta, maxReplays: 1 } });
run('H4 replay=off', 'replay', { variant: 'H4', replay: { mode: 'none' } });

// ---- calibration ------------------------------------------------------------
run('H2 + calibration', 'calibration', { variant: 'H2', calibrate: true });

// ---- write --------------------------------------------------------------------
const slim = (e) => ({ name: e.name, family: e.family, conf: e.conf, fit: e.fit, held: e.held, all: e.allM,
  replay: e.runs.replayStats?.map((s) => ({ replays: s.replays, changes: s.changes, tokens: s.tokens })) ?? null });
writeFileSync(`${OUT}sweeps.json`, JSON.stringify({ grids, byKind, configs: all.map(slim) }, (k, v) => (v === Infinity ? 'Infinity' : v), 1));
const front = pareto(all.map((e) => ({ name: e.name, m: e.fit })));
writeFileSync(`${OUT}pareto-fit.json`, JSON.stringify(front.map((p) => ({ name: p.name, success: p.m.success, tokensPerSuccess: p.m.tokensPerSuccess })), null, 1));
// Paired held-out deltas of every config against H2 and H0.
const deltas = all.map((e) => ({ name: e.name, vsH2: pairedDelta(H2.runs, e.runs, HELD), vsH0: pairedDelta(H0.runs, e.runs, HELD), vsH4: e.family === 'replay' ? pairedDelta(H4.runs, e.runs, HELD) : null }));
writeFileSync(`${OUT}deltas-heldout.json`, JSON.stringify(deltas, null, 1));
// The runs, for the combination stage.

log('done');
