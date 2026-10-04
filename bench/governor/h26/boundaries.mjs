// H2.6 design constants: re-derivation, and validation of the full analysis
// procedure under the null (DESIGN.md §7). Validation only: nothing computed
// here may change a pre-registered constant.
//   node bench/governor/h26/boundaries.mjs [trialsPerScenario] [outFile]
//     → bench/governor/h26/boundaries-result.json (the frozen 40,000-trial run)
import { readFileSync, writeFileSync } from 'node:fs';

const SEED = 20261002;
const TRIALS = Number(process.argv[2] ?? 20000);
const HERE = new URL('.', import.meta.url).pathname;

// --- the pre-registered constants (DESIGN.md §7) ------------------------------
const N_MAX = 3035;
const LOOKS = [759, 1518, 2277, 3035];
const EFFICACY = [4.046, 2.861, 2.336, 2.023];
const SAFETY_Z = 2.363;
const SAFETY_MARGIN = 0.02;
const THETA = 2.843;
const CP_MIN = 0.10;
const EPS = 0.5;

// --- deterministic PRNG (sfc32) ------------------------------------------------
function rng(seed) {
  let a = 0x9e3779b9, b = 0x243f6a88, c = 0xb7e15162, d = seed >>> 0;
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (a + b) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11); d = (d + 1) | 0; const r = (t + d) | 0; c = (c + r) | 0;
    return (r >>> 0) / 4294967296;
  };
  for (let i = 0; i < 20; i++) next();
  let spare = null;
  return {
    u: next,
    normal() {
      if (spare !== null) { const s = spare; spare = null; return s; }
      let u1 = next(); while (u1 <= 1e-300) u1 = next();
      const r = Math.sqrt(-2 * Math.log(u1)); const th = 2 * Math.PI * next();
      spare = r * Math.sin(th); return r * Math.cos(th);
    },
  };
}
const Phi = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
// erf via the Numerical Recipes erfc Chebyshev fit, |error| < 1.2e-7.
function erf(x) {
  const t = 1 / (1 + 0.5 * Math.abs(x));
  const y = 1 - t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806
    + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? y : -y;
}

// --- part 1: Brownian re-derivation of the boundaries ----------------------------
function brownian(trials, seed) {
  const R = rng(seed); const K = 4;
  const Z = new Float64Array(trials * K);
  for (let i = 0; i < trials; i++) { let s = 0; for (let k = 0; k < K; k++) { s += R.normal(); Z[i * K + k] = s / Math.sqrt(k + 1); } }
  const crossTwo = (b) => { let n = 0; for (let i = 0; i < trials; i++) for (let k = 0; k < K; k++) if (Math.abs(Z[i * K + k]) >= b[k]) { n++; break; } return n / trials; };
  const crossOne = (c) => { let n = 0; for (let i = 0; i < trials; i++) for (let k = 0; k < K; k++) if (Z[i * K + k] >= c) { n++; break; } return n / trials; };
  const cumulative = EFFICACY.map((_, j) => { let n = 0; for (let i = 0; i < trials; i++) for (let k = 0; k <= j; k++) if (Math.abs(Z[i * K + k]) >= EFFICACY[k]) { n++; break; } return n / trials; });
  // Power of the efficacy boundaries under the design drift θ.
  let power = 0; const R2 = rng(seed + 1);
  for (let i = 0; i < trials; i++) { let s = 0; for (let k = 0; k < K; k++) { s += R2.normal() + THETA / 2; if (s / Math.sqrt(k + 1) >= EFFICACY[k]) { power++; break; } } }
  return { trials, alphaEfficacy: crossTwo(EFFICACY), cumulativeAlpha: cumulative, alphaSafetyOneSided: crossOne(SAFETY_Z), powerAtTheta: power / trials };
}

// --- part 2: the actual procedure under the null ---------------------------------
// Y = C(b*→end) + 1[unresolved] · C(task), with C(b*→end) = f · C(task),
// f ~ U(0.3, 0.9). Arms have equal E[Y] (the null) and unequal spread. The
// resolution rate r is equal in both arms (null for the safety endpoint too).
function lognormalOfMean(mean, sigma) { const mu = Math.log(mean) - sigma * sigma / 2; return (R) => Math.exp(mu + sigma * R.normal()); }
function paretoOfMean(mean, alpha) { const xm = mean * (alpha - 1) / alpha; return (R) => xm / Math.pow(1 - R.u(), 1 / alpha); }

function armBLognormal() {
  // The C(task) scale and spread fitted to the 20 Arm B runs' cost (USD).
  try {
    const rows = JSON.parse(readFileSync(`${HERE}../real/collected.json`, 'utf8'));
    const xs = rows.map((r) => r.usage.reduce((s, u) => s + (u.usd ?? 0), 0)).filter((x) => x > 0).map(Math.log);
    const m = xs.reduce((a, b) => a + b, 0) / xs.length; const s = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
    return { mean: Math.exp(m + s * s / 2), sigma: s, n: xs.length };
  } catch { return { mean: 0.25, sigma: 0.8, n: 0 }; }
}
const armB = armBLognormal();

const SCENARIOS = {
  'normal, equal variance (sanity)': { r: 0.5, a: (R) => 1 + R.normal(), m: (R) => 1 + R.normal(), raw: true },
  'lognormal σ 0.8 vs 1.3': { r: 0.5, a: lognormalOfMean(1, 0.8), m: lognormalOfMean(1, 1.3) },
  'lognormal σ 1.3 vs 0.8': { r: 0.5, a: lognormalOfMean(1, 1.3), m: lognormalOfMean(1, 0.8) },
  'Pareto α 3 vs lognormal σ 0.8': { r: 0.5, a: paretoOfMean(1, 3), m: lognormalOfMean(1, 0.8) },
  'Arm B-fitted lognormal, ×1.5 spread in masked, r 0.3': { r: 0.3, a: lognormalOfMean(armB.mean, armB.sigma), m: lognormalOfMean(armB.mean, armB.sigma * 1.5) },
};

function trial(sc, R) {
  const st = { a: { n: 0, s: 0, q: 0, res: 0 }, m: { n: 0, s: 0, q: 0, res: 0 } };
  let k = 0; let full = null; let effOnly = null; const out = { safetyHarm: false, safetyWithhold: false, futility: false, maskedAtFinal: 0 };
  while (k < LOOKS.length) {
    const arm = R.u() < EPS ? st.m : st.a;
    const c = (arm === st.m ? sc.m : sc.a)(R);
    const resolved = R.u() < sc.r;
    const y = sc.raw ? c : (0.3 + 0.6 * R.u()) * c + (resolved ? 0 : c);
    arm.n++; arm.s += y; arm.q += y * y; arm.res += resolved ? 1 : 0;
    if (Math.min(st.a.n, st.m.n) < LOOKS[k]) continue;
    // A scheduled look.
    const v = (x) => (x.q - x.s * x.s / x.n) / (x.n - 1);
    const se = Math.sqrt(v(st.a) / st.a.n + v(st.m) / st.m.n);
    const z = (st.a.s / st.a.n - st.m.s / st.m.n) / se;
    const t = LOOKS[k] / N_MAX;
    const rejects = Math.abs(z) >= EFFICACY[k];
    if (effOnly === null && rejects) effOnly = true;
    if (full === null) {
      if (rejects) full = 'reject';
      else {
        const ra = st.a.res / st.a.n, rm = st.m.res / st.m.n, d = ra - rm;
        const zr = d / Math.sqrt(ra * (1 - ra) / st.a.n + rm * (1 - rm) / st.m.n);
        if (zr <= -SAFETY_Z && d <= -SAFETY_MARGIN) { full = 'safety'; out.safetyHarm = true; }
        else if (zr >= SAFETY_Z && d >= SAFETY_MARGIN) { full = 'safety'; out.safetyWithhold = true; }
        else if ((k === 1 || k === 2)) {
          const B = Math.abs(z) * Math.sqrt(t);
          const cp = 1 - Phi((EFFICACY[3] - B - THETA * (1 - t)) / Math.sqrt(1 - t));
          if (cp < CP_MIN) { full = 'futility'; out.futility = true; }
        }
      }
    }
    if (k === LOOKS.length - 1) out.maskedAtFinal = st.m.n;
    k++;
  }
  out.rejectFull = full === 'reject'; out.rejectEffOnly = effOnly === true;
  return out;
}

function runScenario(name, sc, seed) {
  const R = rng(seed); const agg = { rejectFull: 0, rejectEffOnly: 0, safetyHarm: 0, safetyWithhold: 0, futility: 0 };
  const masked = [];
  for (let i = 0; i < TRIALS; i++) { const o = trial(sc, R); for (const key of Object.keys(agg)) if (o[key]) agg[key]++; masked.push(o.maskedAtFinal); }
  const rate = (x) => x / TRIALS; const mcse = (p) => Math.sqrt(p * (1 - p) / TRIALS);
  masked.sort((a, b) => a - b);
  const pAbove = (cap) => masked.filter((m) => m > cap).length / TRIALS;
  return {
    name, trials: TRIALS,
    typeIFullProcedure: rate(agg.rejectFull), typeIEfficacyOnly: rate(agg.rejectEffOnly), mcse: mcse(rate(agg.rejectEffOnly)),
    falseHarmStop: rate(agg.safetyHarm), falseBenefitForWithholdingStop: rate(agg.safetyWithhold), futilityStop: rate(agg.futility),
    maskedWhenFinalLookReached: { median: masked[Math.floor(TRIALS / 2)], p99: masked[Math.floor(0.99 * TRIALS)], p999: masked[Math.floor(0.999 * TRIALS)], max: masked.at(-1), pAbove3035: pAbove(3035), pAbove3400: pAbove(3400) },
  };
}

const started = Date.now();
const brown = brownian(2_000_000, SEED);
const scenarios = Object.entries(SCENARIOS).map(([name, sc], i) => runScenario(name, sc, SEED + 100 + i));
const result = { seed: SEED, armBFit: armB, constants: { N_MAX, LOOKS, EFFICACY, SAFETY_Z, SAFETY_MARGIN, THETA, CP_MIN, EPS }, brownian: brown, nullValidation: scenarios, seconds: (Date.now() - started) / 1000 };
writeFileSync(process.argv[3] ?? `${HERE}boundaries-result.json`, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
