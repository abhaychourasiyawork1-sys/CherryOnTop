// Offline evaluation of learned capability value against H0, H2, H2.5
// (feasibility only) and the oracle never-recover upper bound.
//   node bench/governor/offline/learned-run.mjs → offline/results/learned.json
import { writeFileSync } from 'node:fs';
import { taskSet, metrics, pairedDelta, cfg } from './evaluate.mjs';
import { runStream } from './learned-value.mjs';

const OUT = new URL('./results/', import.meta.url).pathname;
const tasks = taskSet();
const FIT = (r) => r.index < 72; const HELD = (r) => r.index >= 72; const ALL = () => true;
const t0 = Date.now(); const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

const auc = (xs, key) => {
  const pos = xs.filter((x) => x.savings > 0); const neg = xs.filter((x) => x.savings <= 0);
  let w = 0; for (const p of pos) for (const n of neg) w += p[key] > n[key] ? 1 : p[key] === n[key] ? 0.5 : 0;
  return pos.length && neg.length ? w / (pos.length * neg.length) : null;
};
function valueStats(runs, filter) {
  const xs = runs.filter(filter).flatMap((r) => r.truth).filter((t) => t.learned)
    .map((t) => ({ savings: t.savings, used: t.learned.used, predicted: t.learned.predicted, learned: t.learned.learned, cap: t.learned.cap, n: t.learned.n }));
  // Calibration: mean predicted vs mean realized saving by quintile of the used value.
  const sorted = [...xs].sort((a, b) => a.used - b.used);
  const bins = [0, 1, 2, 3, 4].map((q) => sorted.slice(Math.floor(q * sorted.length / 5), Math.floor((q + 1) * sorted.length / 5)))
    .map((b) => ({ n: b.length, used: b.reduce((s, x) => s + x.used, 0) / Math.max(1, b.length), realized: b.reduce((s, x) => s + x.savings, 0) / Math.max(1, b.length) }));
  return { n: xs.length, aucUsed: auc(xs, 'used'), aucLearned: auc(xs, 'learned'), aucPredicted: auc(xs, 'predicted'), calibration: bins };
}
const kindMix = (runs, f) => { const m = {}; for (const r of runs.filter(f)) for (const k of r.kinds) m[k] = (m[k] ?? 0) + 1; const n = runs.filter(f).length; for (const k in m) m[k] = +(m[k] / n).toFixed(3); return m; };

const policies = [
  ['H0', 'H0', {}], ['H2', 'H2', {}], ['H2.5', 'H2.5', {}], ['oracle never-recover', 'oracle', {}],
  ['learned (k20 z1 3-level)', 'learned', {}],
  ['learned frozen@72', 'learned', { freezeAt: 72 }],
  ['learned global-only', 'learned', { model: { levels: 1 } }],
  ['learned 2-level', 'learned', { model: { levels: 2 } }],
  ['learned z0', 'learned', { z: 0 }],
  ['learned k5', 'learned', { k: 5 }],
  ['learned k80', 'learned', { k: 80 }],
  ['learned adjusted', 'learned', { model: { adjust: true } }],
  ['learned adjusted frozen@72', 'learned', { model: { adjust: true }, freezeAt: 72 }],
  ['learned adjusted z0', 'learned', { model: { adjust: true }, z: 0 }],
];
const res = {};
for (const [name, policy, o] of policies) { res[name] = runStream(policy, tasks, o); log(name); }

const out = { configs: [] };
const D = (a, b, f) => pairedDelta(res[a], res[b], f);
const oracleAll = D('H2', 'oracle never-recover', ALL).cps; const oracleHeld = D('H2', 'oracle never-recover', HELD).cps;
for (const [name] of policies) {
  const r = res[name];
  const e = {
    name, fit: metrics(r, FIT), held: metrics(r, HELD), all: metrics(r, ALL),
    vsH2: { all: D('H2', name, ALL), held: D('H2', name, HELD) },
    vsH25: { all: D('H2.5', name, ALL), held: D('H2.5', name, HELD) },
    vsH0: { all: D('H0', name, ALL), held: D('H0', name, HELD) },
    recovered: { all: D('H2', name, ALL).cps / oracleAll, held: D('H2', name, HELD).cps / oracleHeld },
    byBucketHeld: Object.fromEntries(['local', 'multi', 'exploratory', 'risky'].map((b) => [b, D('H2', name, (x) => HELD(x) && x.bucket === b)])),
    kinds: { fit: kindMix(r, FIT), held: kindMix(r, HELD) },
    value: name.startsWith('learned') ? { fit: valueStats(r, FIT), held: valueStats(r, HELD) } : null,
  };
  out.configs.push(e);
}
// Capability × regime values the default model holds at the end of each stream,
// against the oracle's realized savings for the same capability (offline only).
const final = res['learned (k20 z1 3-level)'].models.map((m) => Object.fromEntries([...m.cells.entries()].filter(([k]) => !k.split('#')[2]).map(([k, c]) => [k, { n: c.n, meanCtg: +(c.sum / c.n).toFixed(4) }])));
const realized = {};
for (const t of res['H2.5'].flatMap((r) => r.truth)) { const k = t.kind; realized[k] ??= { n: 0, s: 0, pos: 0 }; realized[k].n++; realized[k].s += t.savings; realized[k].pos += t.savings > 0; }
out.capabilityCells = final; out.oracleRealizedH25 = realized;
writeFileSync(`${OUT}learned.json`, JSON.stringify(out, null, 1));
log('done');
