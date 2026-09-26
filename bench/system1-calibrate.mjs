#!/usr/bin/env node
// Refit the `execution.decomposable` calibrator from live Laya.
//
// Asks the *production* question (compiled by dist/system1/compiler.js, sent by
// the production HTTP client, uncalibrated) about every goal in
// bench/system1-calibration/decomposable-goals.json, fits Platt scaling
// (logit(p) -> a*logit(p) + b) by gradient descent on log loss, and reports
// leave-one-out evidence against the regex heuristic it replaced. Paste the
// printed constants into DECOMPOSABLE_PLATT in src/system1/calibration.ts only
// if the leave-one-out numbers beat the current ones, and bump its version.
//
// Usage (after `npm run build`, Laya reachable at ORG_LAYA_URL / default port):
//   node bench/system1-calibrate.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { system1Config } = await import('../dist/config/system1.js');
const { createHttpProvider } = await import('../dist/system1/laya-client.js');
const { compileHarnessRequest } = await import('../dist/system1/compiler.js');
const { layaKey } = await import('../dist/system1/laya-process.js');
const { assessDecomposition } = await import('../dist/intelligence/decompose.js');
const { decompositionBoundary, worthSplittingFrom } = await import('../dist/system1/economic-mapping.js');
const { DECOMPOSABLE_PLATT, plattScale } = await import('../dist/system1/calibration.js');

const goals = JSON.parse(readFileSync(new URL('./system1-calibration/decomposable-goals.json', import.meta.url), 'utf8'));
const config = system1Config();
const provider = createHttpProvider({
  name: 'laya', url: config.url, apiKey: config.apiKey ?? layaKey(path.join(os.homedir(), '.org')),
  timeoutMs: 30_000, model: 'typed-decisions',
});

const rows = [];
for (const { goal, decomposable } of goals) {
  const request = compileHarnessRequest({ surface: 'execution.decomposable', goal, stateVersion: 0 });
  const [judgment] = await provider.decide([request]);
  rows.push({ goal, label: decomposable, p: judgment.result.probabilities.many });
}

const logit = (p) => { const q = Math.min(1 - 1e-6, Math.max(1e-6, p)); return Math.log(q / (1 - q)); };
const sig = (z) => 1 / (1 + Math.exp(-z));
function fit(data) {
  let a = 1, b = 0;
  for (let it = 0; it < 20_000; it++) {
    let ga = 0, gb = 0;
    for (const r of data) { const x = logit(r.p), e = sig(a * x + b) - (r.label ? 1 : 0); ga += e * x; gb += e; }
    a -= 0.05 * ga / data.length; b -= 0.05 * gb / data.length;
  }
  return { a, b };
}
const auc = (data) => {
  const pos = data.filter((r) => r.label), neg = data.filter((r) => !r.label);
  let w = 0; for (const x of pos) for (const y of neg) w += x.p > y.p ? 1 : x.p === y.p ? 0.5 : 0;
  return w / (pos.length * neg.length);
};
const decide = (r, f) => {
  const boundary = decompositionBoundary(assessDecomposition(r.goal).complexity);
  return boundary ? worthSplittingFrom(f(r.p), boundary) : false;
};
const nll = (r, q) => -Math.log(Math.max(1e-9, r.label ? q : 1 - q));

let loo = 0, looRegex = 0, llPlatt = 0, llIdentity = 0, llCurrent = 0, looCurrent = 0;
for (let i = 0; i < rows.length; i++) {
  const c = fit(rows.filter((_, j) => j !== i));
  const f = (p) => plattScale(p, c);
  const r = rows[i];
  loo += decide(r, f) === r.label ? 1 : 0;
  looCurrent += decide(r, (p) => plattScale(p, DECOMPOSABLE_PLATT)) === r.label ? 1 : 0;
  looRegex += assessDecomposition(r.goal).worthSplitting === r.label ? 1 : 0;
  llPlatt += nll(r, f(r.p));
  llIdentity += nll(r, r.p);
  llCurrent += nll(r, plattScale(r.p, DECOMPOSABLE_PLATT));
}
const n = rows.length;
const all = fit(rows);
console.log(`goals: ${n}   raw AUC: ${auc(rows).toFixed(3)}`);
console.log(`decision accuracy   regex heuristic: ${(looRegex / n).toFixed(3)}   refit (leave-one-out): ${(loo / n).toFixed(3)}   shipped ${DECOMPOSABLE_PLATT.version}: ${(looCurrent / n).toFixed(3)}`);
console.log(`log loss            identity: ${(llIdentity / n).toFixed(3)}   refit (leave-one-out): ${(llPlatt / n).toFixed(3)}   shipped: ${(llCurrent / n).toFixed(3)}`);
console.log(`refit on all goals: a=${all.a.toFixed(4)} b=${all.b.toFixed(4)}`);
