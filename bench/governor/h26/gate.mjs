// H2.6 pilot: the funnel, and the pre-registered go / no-go gate
// (bench/governor/h26/DESIGN.md §8). Mechanical; nothing here tunes anything.
//   node bench/governor/h26/gate.mjs <pilotRunsDir> <integration.json>
import { readFileSync } from 'node:fs';
import { CONFIG, collect, outcomeY, mean, variance, quantile, prng, summary } from './analysis.mjs';

/** P(X ≥ x) for X ~ Binomial(n, p). */
function upperTail(n, x, p) {
  let sum = 0; let logC = 0;
  for (let k = 0; k <= n; k++) {
    if (k > 0) logC += Math.log(n - k + 1) - Math.log(k);
    if (k >= x) sum += Math.exp(logC + k * Math.log(p || 1e-300) + (n - k) * Math.log(1 - p || 1e-300));
  }
  return sum;
}

/** One-sided Clopper–Pearson lower bound: the p at which P(X ≥ x) = α. */
export function clopperPearsonLower(x, n, alpha = CONFIG.gate.cpOneSidedAlpha) {
  if (x <= 0) return 0;
  let lo = 0; let hi = x / n;
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (upperTail(n, x, mid) < alpha) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

/** max(c̄ + t·s/√n, 95th percentile of bootstrap means). */
export function costUpperBound(costs, seed = CONFIG.seeds.gateBootstrap, resamples = CONFIG.gate.bootstrapResamples) {
  const n = costs.length;
  const tBound = mean(costs) + CONFIG.gate.tQuantile * Math.sqrt(variance(costs)) / Math.sqrt(n);
  const rand = prng(seed);
  const means = Array.from({ length: resamples }, () => mean(Array.from({ length: n }, () => costs[Math.floor(rand() * n)])));
  return { cU: Math.max(tBound, quantile(means, 0.95)), tBound, bootstrapP95: quantile(means, 0.95) };
}

export function gate({ x, n, costs, budgetUsd, integrationPassed }) {
  const pL = clopperPearsonLower(x, n);
  const { cU, tBound, bootstrapP95 } = costUpperBound(costs);
  const nTasksU = pL > 0 ? Math.ceil((2 * CONFIG.nMax) / pL) : Infinity;
  const costU = nTasksU * cU;
  const go = x >= 1 && budgetUsd !== null && costU <= budgetUsd && integrationPassed === true;
  return { x, n, pL, cU, tBound, bootstrapP95, nTasksU, costU, budgetUsd, integrationPassed, decision: go ? 'GO' : 'NO-GO' };
}

/** Integration criterion 3: the masked count's two-sided 95 % Clopper–Pearson
 *  interval for p, from n_triggered draws, contains 0.5. */
export function balanceCheck(masked, triggered) {
  if (triggered === 0) return { masked, triggered, interval: null, passed: true };
  const lo = clopperPearsonLower(masked, triggered, 0.025);
  const hi = 1 - clopperPearsonLower(triggered - masked, triggered, 0.025);
  return { masked, triggered, interval: [lo, hi], passed: lo <= 0.5 && 0.5 <= hi };
}

/** n is the scheduled pilot size (§8): a scheduled task with no run database
 *  counts in the denominator as not triggered. */
export function funnel(runs, n = CONFIG.pilot.n) {
  const rows = runs.flatMap((r) => r.rows);
  const share = (k) => ({ count: k, ofAll: n ? k / n : null });
  const triggered = runs.filter((r) => r.funnel.triggered).length;
  const w1 = rows.filter((r) => r.W === true);
  const ys = rows.filter((r) => r.final).map(outcomeY);
  return {
    tasks: n,
    governableBoundary: share(runs.filter((r) => r.funnel.governable).length),
    recoverCandidate: share(runs.filter((r) => r.funnel.recoverCandidate).length),
    triggered: share(triggered),
    wouldSelect: share(w1.length),
    carryOutAvailableW1: w1.filter((r) => r.Z === 'available').length ? w1.filter((r) => r.Z === 'available' && r.carriedAtBstar).length / w1.filter((r) => r.Z === 'available').length : null,
    substitutionMaskedW1: w1.filter((r) => r.Z === 'masked').length ? w1.filter((r) => r.Z === 'masked' && r.substitute).length / w1.filter((r) => r.Z === 'masked').length : null,
    outcome: ys.length > 1 ? summary(ys) : null,
    balance: { nAvailable: rows.filter((r) => r.Z === 'available').length, nMasked: rows.filter((r) => r.Z === 'masked').length,
      ratio: rows.filter((r) => r.Z === 'masked').length ? rows.filter((r) => r.Z === 'available').length / rows.filter((r) => r.Z === 'masked').length : null },
    criterion3: balanceCheck(rows.filter((r) => r.Z === 'masked').length, rows.length),
    maskedCarriedAtBstar: rows.filter((r) => r.Z === 'masked' && r.carriedAtBstar).length,
    writeFailures: runs.reduce((s, r) => s + r.funnel.writeFailures, 0),
    // D2 diagnostics: whether the reservation changed first-dispatch
    // completion. Reported; T and R are not tunable from them (§8).
    d2: runs.map((r) => {
      const first = r.funnel.d2[0] ?? null;
      return {
        run: r.run, firstDispatchCap: first?.cap ?? null, firstDispatchTurns: r.funnel.firstDispatchTurns,
        firstDispatchCapHit: first && r.funnel.firstDispatchTurns !== null ? r.funnel.firstDispatchTurns >= first.cap : null,
        firstDispatchTermination: r.funnel.firstOutcome ? (r.funnel.firstOutcome.succeeded ? 'completed' : r.funnel.firstOutcome.message ?? 'failed') : null,
        dispatchesToBstar: r.rows[0]?.dispatchesToBstar ?? null,
      };
    }),
    costPerTaskUsd: runs.map((r) => r.funnel.taskCostUsd),
  };
}

if (process.argv[1] && process.argv[1].endsWith('gate.mjs')) {
  const runs = collect(process.argv[2]);
  const integration = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const f = funnel(runs);
  const g = gate({ x: f.triggered.count, n: f.tasks, costs: f.costPerTaskUsd, budgetUsd: CONFIG.budgetUsd,
    integrationPassed: integration.allPassed === true && f.criterion3.passed });
  console.log(JSON.stringify({ funnel: f, gate: g }, null, 1));
}
