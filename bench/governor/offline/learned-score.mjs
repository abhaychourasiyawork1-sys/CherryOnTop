// Off-policy check of the learned model's *signal*, free of its feedback loop:
// H2.5 runs unchanged; the model learns from H2.5's own runtime-visible
// outcomes, chronologically, and scores each carried intervention with the
// model as it stood at that decision. AUC is then taken against the oracle
// (offline only). Also: the sample size an outcome-based learner would need.
//   node bench/governor/offline/learned-score.mjs
import { writeFileSync } from 'node:fs';
import { taskSet, cfg, oracle } from './evaluate.mjs';
import { createValueModel, regimeOf, featuresOf, capabilityOf } from './learned-value.mjs';
import { isExecutable } from '../../../dist/lifecycle/executable.js';
import { runTask } from '../sim.mjs';

const tasks = taskSet();
const out = {};
for (const adjust of [false, true]) {
  const rows = []; const ys = [];
  for (let rep = 0; rep < 3; rep++) {
    const model = createValueModel({ adjust }); const history = new Map();
    tasks.forEach((task, index) => {
      const views = []; const scored = new Map();
      const opts = { variant: 'H2', rep, regime: 'M1', history, executable: isExecutable,
        observe: ({ state }) => views.push({ version: state.version, consumed: state.resources.consumedTokens, budget: state.resources.totalTokenBudget, r: regimeOf(state), x: featuresOf(state) }),
        gate: (view) => {
          const c = view.decision.action; const l = model.advantage(capabilityOf(c), regimeOf(view.state));
          scored.set(`${view.state.version}|${c.id}`, { adv: l.adv * view.state.resources.totalTokenBudget, n: l.n, cap: capabilityOf(c) });
          return c;
        } };
      const run = runTask(task, cfg, opts);
      const seen = [...views]; const s = new Map(scored);
      for (const t of oracle(task, run, opts, 3)) { const x = s.get(`${t.version}|${t.id}`); if (x) rows.push({ ...x, savings: t.savings, index }); }
      const w = run.w; const carried = new Map(w.trace.filter((e) => (e.kind === 'intervention' || e.kind === 'recovery') && e.tokens > 0 && e.capability !== 'agent').map((e) => [e.version, e]));
      const ivAt = new Map(w.interventions.map((i) => [i.version, i]));
      for (const v of seen) {
        const iv = ivAt.get(v.version); const ev = carried.get(v.version);
        const y = ((w.tokens - v.consumed) + (w.outcome.validated ? 0 : w.tokens)) / Math.max(1, v.budget);
        model.observe(iv && ev ? `${iv.kind}|${ev.capability}` : 'continue|agent.continue', v.r, y, v.x); ys.push(y);
      }
      model.commit();
      if (run.w.outcome.validated) history.set(task.repo, (history.get(task.repo) ?? 0) + 1);
    });
  }
  const auc = (xs) => { const p = xs.filter((x) => x.savings > 0), n = xs.filter((x) => x.savings <= 0); let w = 0; for (const a of p) for (const b of n) w += a.adv > b.adv ? 1 : a.adv === b.adv ? 0.5 : 0; return w / (p.length * n.length); };
  const held = rows.filter((r) => r.index >= 72 && r.n > 0);
  const byCap = {}; for (const r of held) (byCap[r.cap] ??= []).push(r);
  const mean = ys.reduce((a, b) => a + b, 0) / ys.length; const sd = Math.sqrt(ys.reduce((a, b) => a + (b - mean) ** 2, 0) / ys.length);
  out[adjust ? 'adjusted' : 'unadjusted'] = {
    labelled: rows.length, heldWithData: held.length, aucHeld: auc(held),
    aucWithinCapability: Object.fromEntries(Object.entries(byCap).filter(([, v]) => v.some((x) => x.savings > 0) && v.some((x) => x.savings <= 0)).map(([k, v]) => [k, { n: v.length, auc: auc(v) }])),
    meanLearnedAdv: Object.fromEntries(Object.entries(byCap).map(([k, v]) => [k, Math.round(v.reduce((a, x) => a + x.adv, 0) / v.length)])),
    meanRealized: Object.fromEntries(Object.entries(byCap).map(([k, v]) => [k, Math.round(v.reduce((a, x) => a + x.savings, 0) / v.length)])),
    ctgSdNormalized: sd,
  };
}
// Power: realized effect sizes (oracle, offline) against outcome noise.
const budget = 60 * 7000;
for (const [k, eff] of [['recover', -3788], ['acquire_evidence', -870]]) {
  const d = Math.abs(eff) / budget; const sd = out.unadjusted.ctgSdNormalized;
  out[`power:${k}`] = { effectNormalized: d, perArmFor2SE: Math.ceil(2 * (2 * sd / d) ** 2 / 2) };
}
writeFileSync(new URL('./results/learned-score.json', import.meta.url).pathname, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
