// Runs every pass of the pre-registered governor benchmark and writes raw,
// per-run JSONL to bench/governor/results/. No analysis here — see analyze.mjs.
//
//   node bench/governor/run.mjs            (needs `npm run build`)
import { readFileSync, writeFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { makeTaskSet, runTask, traceOf, hashUnit, BUCKETS } from './sim.mjs';
import { learnFromTask, emptyGovernorMemoryFn, createDormantPoolFn } from './deps.mjs';
import { analyzeTask } from '../../dist/governor/miss.js';
import { actionCandidate } from '../../dist/decision/actions.js';

const HERE = new URL('.', import.meta.url).pathname;
const cfg = JSON.parse(readFileSync(`${HERE}config.json`, 'utf8'));
// GOV_BENCH_DRY=<dir>: a tiny run of the whole pipeline into a scratch dir, for
// checking the harness before the frozen run. Never used for results.
const DRY = process.env.GOV_BENCH_DRY;
if (DRY) {
  cfg.passA = { ...cfg.passA, tasksPerBucket: 1, reps: 1 };
  cfg.passB = { ...cfg.passB, tasksPerBucket: 2, reps: 1 };
  cfg.learningSplit = { train: 4, adapt: 2, heldOut: 2 };
  cfg.stress = { ...cfg.stress, tasks: 2, reps: 1 };
}
const OUT = DRY || `${HERE}results`;
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// Fingerprint: model + runtime + harness + policy + repo + taskset
// ---------------------------------------------------------------------------
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: HERE }).toString().trim();
const distHash = createHash('sha256');
for (const f of ['governor/governor.js', 'governor/risk.js', 'governor/coverage.js', 'governor/horizon.js', 'governor/miss.js',
  'governor/ladder.js', 'governor/memory.js', 'governor/contracts.js', 'decision/engine.js', 'decision/utility.js', 'decision/orchestration-loop.js']) {
  distHash.update(readFileSync(`${HERE}../../dist/${f}`));
}
const fingerprint = {
  generation: cfg.generation, model: 'simulated-agent (bench/governor/sim.mjs)', node: process.version,
  harness: distHash.digest('hex').slice(0, 16), gitHead: head,
  config: createHash('sha256').update(JSON.stringify(cfg)).digest('hex').slice(0, 16),
  sim: createHash('sha256').update(readFileSync(`${HERE}sim.mjs`)).digest('hex').slice(0, 16),
  startedAt: new Date().toISOString(),
};
writeFileSync(`${OUT}/fingerprint.json`, JSON.stringify(fingerprint, null, 2));

const TE = cfg.world.trueEffects;
const UNIVERSE = Object.keys(TE).filter((k) => k !== 'proposal:noise');

/** Which intervention family, in ground-truth terms, a candidate is. */
function familyOf(c) {
  const fp = typeof c.metadata?.fingerprint === 'string' ? c.metadata.fingerprint : c.id;
  if (TE[fp]) return fp;
  if (c.id.startsWith('evidence:')) return 'context-read';
  if (c.kind === 'recover') return 'recover';
  if (c.id.startsWith('historical:')) return 'historical';
  if (c.id.startsWith('proposal:')) return String(c.metadata?.advice ?? '').toLowerCase().includes('callers') ? 'proposal:special' : 'proposal:noise';
  if (c.id.startsWith('SEQ(') || c.id.startsWith('PAR(')) return 'composite';
  return null;
}

/** Ground truth: is this family useful against the world as it stands at a
 *  boundary? Prevents a mode starting within 8 steps, or detects an active
 *  undetected one. */
function useful(family, modes, version) {
  const e = TE[family];
  if (!e) return false;
  return modes.some((m) => (m.status === 'pending' && m.onset <= version + 8
    && ((m.special ? (e.special ?? 0) : (e.prevent?.[m.dim] ?? 0)) >= 0.25))
    || (m.status === 'active' && !m.hidden && (e.detect ?? 0) >= 0.25));
}

function recallOf(run) {
  let opportunities = 0; const hit = { 1: 0, 3: 0, 5: 0 }; let genMiss = 0;
  for (const b of run.boundaries) {
    if (!b.deep) continue;
    const anyUseful = UNIVERSE.some((f) => useful(f, b.modes, b.version));
    if (!anyUseful) continue;
    opportunities += 1;
    const ranked = (b.decision.candidates ?? []).filter((c) => c.rank !== null && c.kind !== 'continue' && c.kind !== 'stop' && c.id !== 'governor:discover')
      .sort((x, y) => x.rank - y.rank);
    const consideredFamilies = new Set(b.considered.flatMap((c) => (familyOf(c) === 'composite'
      ? (c.metadata.parts ?? []).map(familyOf) : [familyOf(c)])));
    if (![...consideredFamilies].some((f) => f && useful(f, b.modes, b.version))) genMiss += 1;
    const byId = new Map(b.considered.map((c) => [c.id, c]));
    const fam = (snap) => {
      const c = byId.get(snap.id);
      if (!c) return [];
      return familyOf(c) === 'composite' ? (c.metadata.parts ?? []).map(familyOf) : [familyOf(c)];
    };
    for (const k of [1, 3, 5]) if (ranked.slice(0, k).some((s) => fam(s).some((f) => f && useful(f, b.modes, b.version)))) hit[k] += 1;
  }
  return { opportunities, r1: hit[1], r3: hit[3], r5: hit[5], genMiss };
}

/** Ground truth prevention debt: loss from modes that a feasible useful
 *  intervention family could have prevented before onset, and that were not
 *  prevented. */
function preventableLoss(run) {
  const tps = run.task.tps;
  let tokens = 0;
  for (const m of run.w.modes) {
    const preventable = UNIVERSE.some((f) => (m.special ? (TE[f].special ?? 0) : (TE[f].prevent?.[m.dim] ?? 0)) >= 0.25);
    if (!preventable) continue;
    if (m.status === 'detected' || m.status === 'fixed' || m.status === 'abandoned') tokens += (m.rework ?? 0) * tps;
    if ((m.status === 'abandoned' || (m.status === 'active' && m.hidden))) tokens += run.w.tokens;
  }
  return tokens;
}

/** One run, with every metric the protocol needs. `oracle` adds masked
 *  re-runs for intervention value truth (first three interventions). */
function record(run, meta, extra = {}) {
  const w = run.w;
  const appliedSteps = new Set(w.interventions.map((i) => i.version)).size;
  const stats = run.node.stats;
  const analysis = run.packets.length > 0 ? analyzeTask(traceOf(run, extra.pool ?? [])) : null;
  const calibration = run.packets.filter((p) => p.risk).map((p) => ({
    p: p.risk.immediateFailureProbability,
    y: w.trace.some((e) => e.version > p.stateVersion && e.kind === 'failure') || !w.outcome.succeeded ? 1 : 0,
  }));
  return {
    ...meta,
    taskId: run.task.id, bucket: run.task.bucket, long: run.task.long, repo: run.task.repo, modes: run.task.modes.length,
    success: w.outcome.succeeded, validated: w.outcome.validated, hidden: !!w.outcome.hiddenFailure, reason: w.outcome.reason,
    recovery: w.trace.some((e) => e.kind === 'failure'),
    tokens: w.tokens, agentTokens: w.agentTokens, interventionTokens: w.interventionTokens, disruptionTokens: w.disruptionTokens,
    discoveryTokens: w.discoveryTokens, replayTokens: extra.replayTokens ?? 0,
    governorOverheadTokens: run.governorOverheadTokens + (extra.replayTokens ?? 0),
    latencyMs: w.latencyMs + w.marketMs, marketMs: w.marketMs,
    steps: w.step, autonomousSteps: w.step - appliedSteps, interventions: w.interventions.length,
    evaluations: stats.evaluations, deepEvaluations: run.boundaries.filter((b) => b.deep).length,
    horizons: stats.horizons, discoveries: stats.discoveries, compositions: stats.compositionsBuilt,
    proposalsAccepted: w.proposalsAccepted, packetBytes: stats.packetBytes, marketRuns: stats.marketRuns,
    recall: recallOf(run), preventableLoss: preventableLoss(run),
    estimated: analysis ? {
      outcomeClass: analysis.outcomeClass, misses: analysis.misses.map((m) => m.label), preventionDebt: analysis.preventionDebt,
      interventionRegret: analysis.interventionRegret, nearMiss: analysis.nearMiss,
    } : null,
    interventionsTruth: extra.truth ?? [],
    calibration,
    ...(extra.learning ? { learning: extra.learning } : {}),
  };
}

function oracleTruth(task, base, opts) {
  const out = [];
  for (const iv of base.w.interventions.slice(0, 3)) {
    const masked = runTask(task, cfg, { ...opts, mask: iv.index });
    const expected = task.steps * task.tps;
    const savings = (masked.w.tokens - base.w.tokens) + ((base.w.outcome.succeeded ? 1 : 0) - (masked.w.outcome.succeeded ? 1 : 0)) * expected;
    out.push({ id: iv.id, kind: iv.kind, utilityTokens: iv.utility / cfg.usdPerToken, savings, version: iv.version });
  }
  return out;
}

/** The replay executor the H4 ladder may buy: re-runs the task from scratch
 *  with the hindsight intervention forced at the boundary, under different
 *  exogenous noise (a real replay is not the same draw). */
function replayFor(task, opts, advice) {
  return ({ packet, intervention, replays }) => {
    const out = [];
    for (let k = 0; k < replays; k++) {
      const candidate = actionCandidate({ id: intervention.fingerprint, kind: 'acquire_evidence', capability: intervention.capability,
        metadata: { fingerprint: intervention.fingerprint, ...(advice.get(intervention.fingerprint) ? { advice: advice.get(intervention.fingerprint) } : {}) } });
      const r = runTask(task, cfg, { ...opts, salt: `replay-${packet.stateVersion}-${k}`, force: { version: packet.stateVersion, candidate } });
      out.push({ succeeded: r.w.outcome.validated, tokens: r.w.tokens });
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// A stream: one variant × regime × rep over a chronological task list.
// ---------------------------------------------------------------------------
function stream({ pass, tasks, variant, regime, rep, oracle = false, split = null, sink }) {
  const memory = emptyGovernorMemoryFn();
  const pool = createDormantPoolFn();
  const history = new Map();
  tasks.forEach((task, index) => {
    const window = split ? (index < split.train ? 'train' : index < split.train + split.adapt ? 'adapt' : 'heldout') : 'all';
    const warm = regime === 'M2';
    const opts = {
      variant, rep, regime, history: regime === 'M0' ? null : history,
      memory: warm ? memory : emptyGovernorMemoryFn(), pool: warm ? pool : createDormantPoolFn(),
    };
    const run = runTask(task, cfg, opts);
    const truth = oracle && variant !== 'H0' ? oracleTruth(task, run, opts) : [];
    let learning = null;
    let replayTokens = 0;
    // H4 learns from each finished task, except in the held-out window, where
    // memory is frozen so a held-out outcome never updates anything.
    if (variant === 'H4' && warm && window !== 'heldout') {
      const advice = new Map(run.packets.flatMap((p) => p.candidates).map((c) => [c.fingerprint, null]));
      for (const b of run.boundaries) for (const c of b.considered) if (typeof c.metadata.advice === 'string') advice.set(c.metadata.fingerprint ?? c.id, c.metadata.advice);
      const result = learnFromTask({
        trace: { ...traceOf(run, pool.entries()), motifs: memory.motifs }, memory, pool,
        replay: replayFor(task, { ...opts, memory: emptyGovernorMemoryFn() }, advice), usdPerToken: cfg.usdPerToken, regime: task.bucket,
      });
      replayTokens = result.diagnosticTokens;
      learning = {
        outcomeClass: result.analysis.outcomeClass, misses: result.analysis.misses.map((m) => m.label),
        diagnoses: result.diagnoses.map((d) => d.option), evidence: result.diagnoses.map((d) => d.evidence?.evidenceLevel ?? null),
        experiences: result.experiencesRecorded, motifs: memory.motifs.length, regretPerLook: memory.regretPerLook,
      };
    }
    if (regime !== 'M0' && run.w.outcome.validated) history.set(task.repo, (history.get(task.repo) ?? 0) + 1);
    sink.write(JSON.stringify(record(run, { pass, variant, regime, rep, index, window }, { truth, learning, replayTokens, pool: pool.entries() })) + '\n');
  });
}

function regimeFor(variant) { return variant === 'H0' ? 'M0' : variant === 'H4' ? 'M2' : 'M1'; }

const started = Date.now();
const log = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(0)}s] ${m}`);

// Pass A
{
  const sink = createWriteStream(`${OUT}/passA.jsonl`);
  const tasks = makeTaskSet(cfg, cfg.passA.seed, cfg.passA.tasksPerBucket);
  // Variants in a randomized (fixed-seed) order per rep.
  for (let rep = 0; rep < cfg.passA.reps; rep++) {
    const order = [...cfg.variants].sort((a, b) => hashUnit('A', rep, a) - hashUnit('A', rep, b));
    for (const variant of order) stream({ pass: 'A', tasks, variant, regime: regimeFor(variant), rep, sink });
  }
  sink.end(); log('pass A done');
}

// Pass B (+ memory study + learning split)
{
  const sink = createWriteStream(`${OUT}/passB.jsonl`);
  const tasks = makeTaskSet(cfg, cfg.passB.seed, cfg.passB.tasksPerBucket);
  const split = cfg.learningSplit;
  const arms = [...cfg.variants.map((v) => [v, regimeFor(v)]), ...cfg.memoryStudy]
    .filter(([v, r], i, all) => all.findIndex(([v2, r2]) => v2 === v && r2 === r) === i);
  for (let rep = 0; rep < cfg.passB.reps; rep++) {
    const order = [...arms].sort((a, b) => hashUnit('B', rep, a.join()) - hashUnit('B', rep, b.join()));
    for (const [variant, regime] of order) {
      stream({ pass: 'B', tasks, variant, regime, rep, oracle: true, split, sink });
      log(`pass B rep ${rep} ${variant}/${regime}`);
    }
  }
  sink.end(); log('pass B done');
}

// Stress sets
{
  const sink = createWriteStream(`${OUT}/stress.jsonl`);
  const S = cfg.stress;
  const per = Math.ceil(S.tasks / BUCKETS.length);
  const sets = {
    easy: { buckets: ['local'], modes: 0, long: false },
    long: { long: true, buckets: ['multi', 'risky'] },
    candidate_generation: { special: true, modes: 1, hidden: false },
    near_miss: { modes: 1, hidden: false, special: false, bucket: { selfCatch: 0, lag: [3, 6] } },
    unavoidable: { unavoidable: true },
    over_intervention: { buckets: ['local'], modes: 0, long: false, bucket: { anchored: 1 } },
    novelty: { buckets: ['exploratory'], bucket: { anchored: 0 } },
  };
  for (const [name, over] of Object.entries(sets)) {
    const tasks = makeTaskSet(cfg, `${S.seed}-${name}`, over.buckets ? Math.ceil(S.tasks / over.buckets.length) : per, over).slice(0, S.tasks);
    for (let rep = 0; rep < S.reps; rep++) {
      for (const variant of S.variants) stream({ pass: `stress:${name}`, tasks, variant, regime: regimeFor(variant), rep, oracle: true, sink });
    }
    log(`stress ${name}`);
  }
  sink.end(); log('stress done');
}
writeFileSync(`${OUT}/fingerprint.json`, JSON.stringify({ ...fingerprint, finishedAt: new Date().toISOString() }, null, 2));
