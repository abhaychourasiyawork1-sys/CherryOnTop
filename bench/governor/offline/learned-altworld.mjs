// Falsification test: a world where recovering genuinely pays. A learned model
// that merely encodes "recover is bad" would lose here; one that learns
// capability value from outcomes should keep recovering. Same tasks and draws;
// only the true effect of recover differs.
//   node bench/governor/offline/learned-altworld.mjs
import { writeFileSync } from 'node:fs';
import { taskSet, metrics, pairedDelta, cfg } from './evaluate.mjs';
import { runStream } from './learned-value.mjs';

const world = structuredClone(cfg);
world.world.trueEffects.recover = { fixBoost: 0.6, cost: 0.05 };
world.world.pFix = 0.15;
const tasks = taskSet();
const HELD = (r) => r.index >= 72; const ALL = () => true;
const res = {};
for (const [name, policy, o] of [['H0', 'H0', {}], ['H2', 'H2', {}], ['H2.5', 'H2.5', {}], ['never-recover', 'oracle', {}],
  ['learned adjusted', 'learned', { model: { adjust: true } }], ['learned unadjusted', 'learned', {}]]) {
  res[name] = runStream(policy, tasks, { world, ...o });
}
const out = Object.fromEntries(Object.keys(res).map((n) => [n, {
  all: metrics(res[n], ALL), vsH25: { all: pairedDelta(res['H2.5'], res[n], ALL), held: pairedDelta(res['H2.5'], res[n], HELD) },
  recoverPerTask: res[n].reduce((s, r) => s + r.kinds.filter((k) => k === 'recover').length, 0) / res[n].length,
}]));
writeFileSync(new URL('./results/learned-altworld.json', import.meta.url).pathname, JSON.stringify(out, null, 1));
for (const [n, e] of Object.entries(out)) console.log(n, `succ ${(e.all.success * 100).toFixed(1)} tps ${(e.all.tokensPerSuccess / 1e3).toFixed(1)}k recover/task ${e.recoverPerTask.toFixed(2)} vsH2.5 all ${(e.vsH25.all.cps * 100).toFixed(1)} [${e.vsH25.all.cpsCI.map((x) => (x * 100).toFixed(1))}] succ ${(e.vsH25.all.success * 100).toFixed(1)} held ${(e.vsH25.held.cps * 100).toFixed(1)}`);
