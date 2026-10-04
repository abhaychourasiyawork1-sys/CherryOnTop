// Statistics for the pre-registered governor benchmark. Reads raw JSONL from a
// results dir and writes summary.json (every number the report uses).
//
//   node bench/governor/analyze.mjs [resultsDir]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const HERE = new URL('.', import.meta.url).pathname;
const DIR = process.argv[2] ?? `${HERE}results`;
const cfg = JSON.parse(readFileSync(`${HERE}config.json`, 'utf8'));
const USD = cfg.usdPerToken;
const load = (f) => (existsSync(`${DIR}/${f}`) ? readFileSync(`${DIR}/${f}`, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const A = load('passA.jsonl');
const B = load('passB.jsonl');
const S = load('stress.jsonl');

// ---------------------------------------------------------------------------
// Small stats kit
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : null);
const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * q; const lo = Math.floor(i); const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const sd = (xs) => { const m = mean(xs); return xs.length > 1 ? Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1)) : null; };
const ci = (xs) => [quantile(xs, 0.025), quantile(xs, 0.975)];

const arm = (rows, variant, regime) => rows.filter((r) => r.variant === variant && (!regime || r.regime === regime));
const byTask = (rows) => {
  const m = new Map();
  for (const r of rows) (m.get(r.taskId) ?? m.set(r.taskId, []).get(r.taskId)).push(r);
  return m;
};

/** Executive + mechanism metrics for one arm. */
function metrics(rows) {
  if (!rows.length) return null;
  const succ = rows.filter((r) => r.success);
  const tokens = sum(rows.map((r) => r.tokens));
  const steps = sum(rows.map((r) => r.steps));
  const ivs = sum(rows.map((r) => r.interventions));
  const horizons = rows.flatMap((r) => r.horizons ?? []);
  const rec = rows.map((r) => r.recall);
  const opp = sum(rec.map((x) => x.opportunities));
  const overhead = sum(rows.map((r) => r.governorOverheadTokens));
  const truth = rows.flatMap((r) => r.interventionsTruth ?? []);
  const calib = rows.flatMap((r) => r.calibration ?? []);
  const brier = calib.length ? mean(calib.map((c) => (c.p - c.y) ** 2)) : null;
  const misses = rows.flatMap((r) => r.estimated?.misses ?? []);
  const confirmedMiss = rows.filter((r) => r.preventableLoss > 0 && !r.success).length;
  return {
    runs: rows.length,
    successRate: succ.length / rows.length,
    validatedRate: rows.filter((r) => r.validated).length / rows.length,
    hiddenFailureRate: rows.filter((r) => r.hidden).length / rows.length,
    recoveryRate: rows.filter((r) => r.recovery).length / rows.length,
    tokensPerTask: tokens / rows.length,
    tokensPerSuccess: succ.length ? tokens / succ.length : null,
    cpsUsd: succ.length ? (tokens * USD) / succ.length : null,
    latencyPerSuccessMin: succ.length ? sum(rows.map((r) => r.latencyMs)) / succ.length / 60_000 : null,
    tokensMedian: quantile(rows.map((r) => r.tokens), 0.5),
    tokensIQR: [quantile(rows.map((r) => r.tokens), 0.25), quantile(rows.map((r) => r.tokens), 0.75)],
    tokensSD: sd(rows.map((r) => r.tokens)),
    autonomyRatio: sum(rows.map((r) => r.autonomousSteps)) / Math.max(1, steps),
    interventionsPerTask: ivs / rows.length,
    interventionRate: ivs / Math.max(1, steps),
    zeroInterventionShare: rows.filter((r) => r.interventions === 0).length / rows.length,
    autonomousSuccessShare: rows.filter((r) => r.success && r.interventions === 0).length / rows.length,
    horizonMean: horizons.length ? mean(horizons) : null,
    horizonMedian: horizons.length ? quantile(horizons, 0.5) : null,
    evaluationsPerTask: mean(rows.map((r) => r.evaluations)),
    deepEvaluationsPerTask: mean(rows.map((r) => r.deepEvaluations)),
    governorOverheadRatio: overhead / Math.max(1, tokens),
    governorOverheadTokensPerTask: overhead / rows.length,
    interventionTokensPerTask: mean(rows.map((r) => r.interventionTokens + r.disruptionTokens)),
    discoveryTokensPerTask: mean(rows.map((r) => r.discoveryTokens)),
    replayTokensPerTask: mean(rows.map((r) => r.replayTokens)),
    discoveriesPerTask: mean(rows.map((r) => r.discoveries)),
    discoveryTriggerRate: rows.filter((r) => r.discoveries > 0).length / rows.length,
    compositionsPerTask: mean(rows.map((r) => r.compositions)),
    proposalsAcceptedPerTask: mean(rows.map((r) => r.proposalsAccepted)),
    marketMsPerTask: mean(rows.map((r) => r.marketMs)),
    marketMsPerEvaluation: sum(rows.map((r) => r.marketMs)) / Math.max(1, sum(rows.map((r) => r.evaluations))),
    packetBytesPerTask: mean(rows.map((r) => r.packetBytes)),
    preventionDebtPerTask: mean(rows.map((r) => r.preventableLoss)),
    preventionDebtEstPerTask: mean(rows.map((r) => r.estimated?.preventionDebt ?? 0)),
    confirmedMissRate: confirmedMiss / rows.length,
    nearMissCount: rows.filter((r) => r.estimated?.nearMiss).length,
    missTaxonomy: Object.fromEntries([...new Set(misses)].map((m) => [m, misses.filter((x) => x === m).length])),
    outcomeClasses: Object.fromEntries([...new Set(rows.map((r) => r.estimated?.outcomeClass).filter(Boolean))]
      .map((c) => [c, rows.filter((r) => r.estimated?.outcomeClass === c).length])),
    opportunityRecall: opp ? { opportunities: opp, at1: sum(rec.map((x) => x.r1)) / opp, at3: sum(rec.map((x) => x.r3)) / opp, at5: sum(rec.map((x) => x.r5)) / opp, generationMissRate: sum(rec.map((x) => x.genMiss)) / opp } : null,
    interventionTruth: truth.length ? {
      n: truth.length,
      productiveRate: truth.filter((t) => t.savings > 0).length / truth.length,
      meanSavings: mean(truth.map((t) => t.savings)),
      regretPerIntervention: mean(truth.map((t) => Math.max(0, -t.savings))),
      roi: sum(truth.map((t) => t.savings)) / Math.max(1, sum(rows.map((r) => r.interventionTokens + r.disruptionTokens))),
    } : null,
    calibration: calib.length ? { n: calib.length, brier, meanPredicted: mean(calib.map((c) => c.p)), observedRate: mean(calib.map((c) => c.y)) } : null,
  };
}

/** Paired task-level bootstrap: CPS ratio-of-sums delta (relative), success
 *  difference, tokens/task delta. Reps averaged within task. */
function paired(rowsA, rowsB, seed = cfg.bootstrap.seed) {
  const ta = byTask(rowsA); const tb = byTask(rowsB);
  const tasks = [...ta.keys()].filter((t) => tb.has(t)).sort();
  if (!tasks.length) return null;
  const agg = (m, t) => { const rs = m.get(t); return { tok: mean(rs.map((r) => r.tokens)), succ: mean(rs.map((r) => (r.success ? 1 : 0))) }; };
  const A2 = tasks.map((t) => agg(ta, t)); const B2 = tasks.map((t) => agg(tb, t));
  const cps = (xs) => sum(xs.map((x) => x.tok)) / Math.max(1e-9, sum(xs.map((x) => x.succ)));
  const point = {
    cpsRelDelta: cps(B2) / cps(A2) - 1,
    successDelta: mean(B2.map((x) => x.succ)) - mean(A2.map((x) => x.succ)),
    tokensRelDelta: sum(B2.map((x) => x.tok)) / sum(A2.map((x) => x.tok)) - 1,
  };
  const rnd = mulberry32(seed);
  const boots = { cps: [], succ: [], tok: [] };
  for (let i = 0; i < cfg.bootstrap.resamples; i++) {
    const idx = tasks.map(() => Math.floor(rnd() * tasks.length));
    const a = idx.map((j) => A2[j]); const b = idx.map((j) => B2[j]);
    boots.cps.push(cps(b) / cps(a) - 1);
    boots.succ.push(mean(b.map((x) => x.succ)) - mean(a.map((x) => x.succ)));
    boots.tok.push(sum(b.map((x) => x.tok)) / sum(a.map((x) => x.tok)) - 1);
  }
  // Run-level 2x2 contingency, paired by (task, rep).
  const key = (r) => `${r.taskId}|${r.rep}`;
  const mA = new Map(rowsA.map((r) => [key(r), r.success]));
  const cont = { both: 0, onlyA: 0, onlyB: 0, neither: 0 };
  for (const r of rowsB) {
    if (!mA.has(key(r))) continue;
    const a = mA.get(key(r)); const b = r.success;
    cont[a && b ? 'both' : a ? 'onlyA' : b ? 'onlyB' : 'neither'] += 1;
  }
  return {
    tasks: tasks.length, ...point,
    cpsRelDeltaCI: ci(boots.cps), successDeltaCI: ci(boots.succ), tokensRelDeltaCI: ci(boots.tok), contingency: cont,
    perTaskTokenDelta: tasks.map((t, i) => ({ taskId: t, delta: B2[i].tok - A2[i].tok, bucket: rowsA.find((r) => r.taskId === t).bucket })),
  };
}

function verdict(p, extraOverheadRatio) {
  if (!p) return 'n/a';
  const [lo, hi] = p.cpsRelDeltaCI; const [slo] = p.successDeltaCI;
  if (hi < 0 && slo >= -0.02) return 'retain';
  if (lo > 0 || slo < -0.02) return 'remove';
  if ((p.cpsRelDelta < 0) !== (p.successDelta > 0) && Math.abs(p.successDelta) > 0.005) return 'modify';
  return extraOverheadRatio > 0.01 ? 'gate more aggressively' : 'retain (neutral, ≤1% overhead)';
}

// ---------------------------------------------------------------------------
const VARIANTS = cfg.variants;
const regimeFor = (v) => (v === 'H0' ? 'M0' : v === 'H4' ? 'M2' : 'M1');
const out = { generation: cfg.generation, fingerprint: existsSync(`${DIR}/fingerprint.json`) ? JSON.parse(readFileSync(`${DIR}/fingerprint.json`, 'utf8')) : null };

for (const [name, rows] of [['passA', A], ['passB', B]]) {
  const sec = { variants: {}, vsH0: {}, vsPrevious: {}, byBucket: {}, byLong: {} };
  for (const v of VARIANTS) sec.variants[v] = metrics(arm(rows, v, regimeFor(v)));
  const h0 = arm(rows, 'H0', 'M0');
  VARIANTS.forEach((v, i) => {
    if (v === 'H0') return;
    sec.vsH0[v] = paired(h0, arm(rows, v, regimeFor(v)));
    const prev = VARIANTS[i - 1];
    sec.vsPrevious[v] = { previous: prev, ...paired(arm(rows, prev, regimeFor(prev)), arm(rows, v, regimeFor(v))) };
  });
  for (const b of ['local', 'multi', 'exploratory', 'risky']) {
    sec.byBucket[b] = Object.fromEntries(VARIANTS.map((v) => [v, metrics(arm(rows, v, regimeFor(v)).filter((r) => r.bucket === b))]));
    sec.byBucket[b].H4vsH0 = paired(h0.filter((r) => r.bucket === b), arm(rows, 'H4', 'M2').filter((r) => r.bucket === b));
  }
  sec.byLong = Object.fromEntries(VARIANTS.map((v) => [v, metrics(arm(rows, v, regimeFor(v)).filter((r) => r.long))]));
  out[name] = sec;
}

// Memory regimes, learning curve and the chronological split (pass B).
{
  const mem = {};
  for (const [v, r] of cfg.memoryStudy) mem[`${v}/${r}`] = metrics(arm(B, v, r));
  const held = (v, r) => arm(B, v, r).filter((x) => x.window === 'heldout');
  out.memory = {
    arms: mem,
    H4_M2_vs_M0_all: paired(arm(B, 'H4', 'M0'), arm(B, 'H4', 'M2')),
    H4_M2_vs_M0_heldout: paired(held('H4', 'M0'), held('H4', 'M2')),
    H4_M1_vs_M0: paired(arm(B, 'H4', 'M0'), arm(B, 'H4', 'M1')),
    H1_M1_vs_M0: paired(arm(B, 'H1', 'M0'), arm(B, 'H1', 'M1')),
    windows: Object.fromEntries(['train', 'adapt', 'heldout'].map((w) => [w, {
      M0: metrics(arm(B, 'H4', 'M0').filter((x) => x.window === w)), M2: metrics(arm(B, 'H4', 'M2').filter((x) => x.window === w)),
    }])),
  };
  // Learning curve: tokens/success over blocks of 12 tasks in chronological order.
  const curve = (v, r) => {
    const rows = arm(B, v, r); const blocks = [];
    for (let s = 0; s < 120; s += 12) {
      const blk = rows.filter((x) => x.index >= s && x.index < s + 12);
      const succ = blk.filter((x) => x.success).length;
      blocks.push({ priorTasks: s, tokensPerSuccess: succ ? sum(blk.map((x) => x.tokens)) / succ : null, success: blk.length ? succ / blk.length : null });
    }
    return blocks;
  };
  out.learningCurve = { M0: curve('H4', 'M0'), M2: curve('H4', 'M2') };
  const learnRows = arm(B, 'H4', 'M2').filter((r) => r.learning);
  const diag = learnRows.flatMap((r) => r.learning.diagnoses);
  out.learning = {
    tasksLearnedFrom: learnRows.length,
    diagnosisOptions: Object.fromEntries([...new Set(diag)].map((d) => [d, diag.filter((x) => x === d).length])),
    evidenceLevels: Object.fromEntries(['weak', 'supported', 'validated'].map((l) => [l, learnRows.flatMap((r) => r.learning.evidence).filter((x) => x === l).length])),
    replayTokensTotal: sum(arm(B, 'H4', 'M2').map((r) => r.replayTokens)),
    finalMotifs: learnRows.at(-1)?.learning.motifs ?? 0,
    regretPerLookFinal: learnRows.at(-1)?.learning.regretPerLook ?? 0,
    missLabels: Object.fromEntries([...new Set(learnRows.flatMap((r) => r.learning.misses))].map((m) => [m, learnRows.flatMap((r) => r.learning.misses).filter((x) => x === m).length])),
  };
  // Replay ROI: tokens saved by warm causal memory over cold in the held-out
  // window, against every replay token spent learning it.
  const p = out.memory.H4_M2_vs_M0_heldout;
  const saved = p ? -sum(p.perTaskTokenDelta.map((x) => x.delta)) * cfg.passB.reps : 0;
  out.learning.replayROI = out.learning.replayTokensTotal > 0 ? saved / out.learning.replayTokensTotal : null;
}

// Mechanism attribution (pass B incremental comparisons).
{
  const v = out.passB.variants;
  const step = (name, from, to) => {
    const p = out.passB.vsPrevious[to];
    const addedOverhead = (v[to]?.governorOverheadRatio ?? 0) - (v[from]?.governorOverheadRatio ?? 0);
    return {
      mechanism: name, from, to,
      netSavingsTokensPerTask: (v[from]?.tokensPerTask ?? 0) - (v[to]?.tokensPerTask ?? 0),
      cpsRelDelta: p?.cpsRelDelta, cpsRelDeltaCI: p?.cpsRelDeltaCI,
      qualityDelta: p?.successDelta, qualityDeltaCI: p?.successDeltaCI,
      addedCostTokensPerTask: (v[to]?.governorOverheadTokensPerTask ?? 0) - (v[from]?.governorOverheadTokensPerTask ?? 0),
      verdict: verdict(p, addedOverhead),
    };
  };
  out.attribution = [
    { ...step('Economic market', 'H0', 'H1') },
    step('Risk/prevention', 'H1', 'H2'),
    step('Candidate discovery (+proposal lane)', 'H2', 'H3a'),
    step('Action composition', 'H3a', 'H3b'),
    step('Adaptive autonomy', 'H3b', 'H3+AH'),
    step('Counterfactual learning (M2)', 'H3+AH', 'H4'),
  ];
}

// Stress tests.
{
  const sets = [...new Set(S.map((r) => r.pass))];
  out.stress = Object.fromEntries(sets.map((s) => {
    const rows = S.filter((r) => r.pass === s);
    const vs = Object.fromEntries(cfg.stress.variants.map((v) => [v, metrics(arm(rows, v, regimeFor(v)))]));
    return [s.replace('stress:', ''), { ...vs, H4vsH0: paired(arm(rows, 'H0', 'M0'), arm(rows, 'H4', 'M2')), H4vsH1: paired(arm(rows, 'H1', 'M1'), arm(rows, 'H4', 'M2')) }];
  }));
}

// Plots' raw series.
{
  out.plots = {
    costVsSuccess: Object.fromEntries(VARIANTS.map((v) => [v, { success: out.passB.variants[v]?.successRate, tokensPerSuccess: out.passB.variants[v]?.tokensPerSuccess }])),
    costDistribution: out.passB.vsH0.H4?.perTaskTokenDelta ?? [],
    interventionEconomics: arm(B, 'H4', 'M2').flatMap((r) => r.interventionsTruth.map((t) => ({ x: t.utilityTokens, y: t.savings, kind: t.kind }))),
    recallVsDiscovery: ['H2', 'H3a', 'H3b', 'H3+AH', 'H4'].map((vv) => ({ variant: vv, discoveryTokensPerTask: out.passB.variants[vv]?.discoveryTokensPerTask, recallAt3: out.passB.variants[vv]?.opportunityRecall?.at3, recallAt1: out.passB.variants[vv]?.opportunityRecall?.at1 })),
    preventionFrontier: arm(B, 'H4', 'M2').flatMap((r) => r.interventionsTruth.map((t) => ({ x: t.version / Math.max(1, r.steps), y: t.savings, roi: t.savings }))),
    learningCurve: out.learningCurve,
  };
}

writeFileSync(`${DIR}/summary.json`, JSON.stringify(out, null, 2));
console.log(`wrote ${DIR}/summary.json`);
