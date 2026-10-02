// Offline threshold evaluator for H2.5 (plan Task 1).
//
// Arm A's world is a deterministic, common-random-number simulation driven by
// the real compiled governor, so "replaying a frozen trajectory under an
// alternate gate" is exact here: the same task, rep and draws, with only the
// gate changed. Gates see only what the runtime sees at a boundary (state,
// decision, candidates, risk snapshot). Ground truth is used afterwards, for
// scoring, and never reaches a gate.
import { readFileSync } from 'node:fs';
import { makeTaskSet, runTask, traceOf, hashUnit } from '../sim.mjs';
import { learnFromTask, VARIANTS } from '../../../dist/governor/governor.js';
import { emptyGovernorMemory, statePattern } from '../../../dist/governor/memory.js';
import { createDormantPool, actionSpaceUncertainty, DISCOVERY_ID } from '../../../dist/governor/coverage.js';
import { riskSnapshot, riskReduction } from '../../../dist/governor/risk.js';
import { DEEP_EVALUATION_TOKEN_COST } from '../../../dist/decision/fast-path.js';
import { actionCandidate } from '../../../dist/decision/actions.js';

const HERE = new URL('.', import.meta.url).pathname;
export const cfg = JSON.parse(readFileSync(`${HERE}../config.json`, 'utf8'));
const PRICE = cfg.usdPerToken;
const TE = cfg.world.trueEffects;
const UNIVERSE = Object.keys(TE).filter((k) => k !== 'proposal:noise');

// ---------------------------------------------------------------------------
// Runtime-visible scores of one candidate at one boundary
// ---------------------------------------------------------------------------

const INFO_KINDS = new Set(['acquire_evidence', 'validate', 'explore', 'reuse_evidence']);

/** Everything a gate may know about a candidate. Built from the boundary view
 *  alone. `snap` is the market's priced snapshot of it. */
export function scoresOf(c, snap, view, calibrate = (p) => p) {
  const { state, decision, risk } = view;
  const cont = decision.candidates.find((s) => s.kind === 'continue');
  const advantage = cont ? (cont.expectedCostUsd - snap.expectedCostUsd) / PRICE : 0;
  const cost = Math.max(1, snap.immediateTokens);
  const pFail = calibrate(risk ? risk.immediateFailureProbability : 0);
  const share = risk ? riskReduction(c, risk) : 0;
  // Preventable share, by the same two channels the market prices (never
  // summed): the contract's doubt removal, or the candidate's own quality
  // claim. A recover acts on a failure already seen: its share is its fix
  // probability.
  const pPrev = Math.max(share, c.expectedQualityBenefit ?? 0, c.kind === 'recover' ? (c.expectedProgress ?? 0) : 0);
  const pSucc = (1 - (c.failureRisk ?? 0)) * (c.confidence ?? 0);
  // Decision change for information: the evidence changes what happens next
  // only if it can reveal a problem (pFail × the share it addresses) and the
  // agent does not already hold it.
  const path = typeof c.metadata?.path === 'string' ? c.metadata.path : null;
  const redundant = path ? state.evidence.some((e) => e.id === `observed:${path}`) : false;
  const info = INFO_KINDS.has(c.kind);
  const pChange = info ? pFail * share * (redundant ? 0 : 1) : null;
  const R = risk ? risk.expectedRecoveryCostTokens : 0;
  return {
    advantage, cost, roi: advantage / cost, pFail, pPrev, pSucc,
    prevention: pFail * pPrev * pSucc, info, pChange,
    dcValueRatio: pChange === null ? null : (pChange * R) / cost,
    infoGain: c.expectedInformationGain ?? 0,
  };
}

/** The market's own order over priced snapshots (engine.ts compareCost). */
function compareSnap(a, b) {
  const d1 = a.conservativeCostUsd - b.conservativeCostUsd; if (Math.abs(d1) > 1e-12) return d1;
  const d2 = a.expectedCostUsd - b.expectedCostUsd; if (Math.abs(d2) > 1e-12) return d2;
  const d3 = b.confidence - a.confidence; if (Math.abs(d3) > 1e-12) return d3;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A gate from a threshold config. It never ranks: it removes candidates that
 *  fail a threshold and lets the market's own order pick among the rest, with
 *  continue (= abstain from buying) always eligible. */
export { compareSnap };
export function makeGate(t = {}, calibrate) {
  const pass = (s) => {
    if (t.intervention !== undefined && s.roi < t.intervention) return false;
    if (t.preventability !== undefined && s.prevention < t.preventability) return false;
    if (t.riskOnly !== undefined && s.pFail < t.riskOnly) return false;
    if (t.decisionChange !== undefined && s.info && s.dcValueRatio < t.decisionChange) return false;
    if (t.infoGain !== undefined && s.info && s.infoGain < t.infoGain) return false;
    return true;
  };
  return (view) => {
    const byId = new Map(view.considered.map((c) => [c.id, c]));
    const eligible = view.decision.candidates
      .filter((s) => s.status !== 'rejected' && s.kind !== 'stop' && s.id !== DISCOVERY_ID)
      .filter((s) => s.kind === 'continue' || (byId.has(s.id) && pass(scoresOf(byId.get(s.id), s, view, calibrate))))
      .sort(compareSnap);
    const best = eligible[0];
    if (!best || best.kind === 'continue') return null;
    return byId.get(best.id);
  };
}

/** Discovery gate: a found option must be worth `margin` × what looking costs
 *  (margin 1 is today's rule). Recomputes the offer's gain from the state and
 *  the node's previous risk reading exactly as governDecision does for the
 *  non-learning variants. */
export function discoveryGate(margin) {
  const gainOf = (state, node) => {
    const risk = riskSnapshot(state, node.prevRisk, 0);
    const U = actionSpaceUncertainty({ state, coverage: [], novelty: 1, generationMissRate: 0 });
    return U * 0.5 * risk.riskExposure;
  };
  return {
    poolFor: (node, base) => {
      const pool = base ?? createDormantPool();
      return {
        entries: () => pool.entries(), add: (e) => pool.add(e),
        activate: (state, exclude, limit, prior) => (gainOf(state, node) > margin * DEEP_EVALUATION_TOKEN_COST
          ? pool.activate(state, exclude, limit, prior) : []),
      };
    },
    inviteGate: ({ state, node }) => gainOf(state, node) > margin * 400,
  };
}

// ---------------------------------------------------------------------------
// Ground-truth scoring (offline only)
// ---------------------------------------------------------------------------

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
function useful(family, modes, version) {
  const e = TE[family];
  if (!e) return false;
  return modes.some((m) => (m.status === 'pending' && m.onset <= version + 8
    && ((m.special ? (e.special ?? 0) : (e.prevent?.[m.dim] ?? 0)) >= 0.25))
    || (m.status === 'active' && !m.hidden && (e.detect ?? 0) >= 0.25));
}
/** Candidate recall against the analytic oracle (run.mjs's definition). */
function recallOf(run) {
  let opportunities = 0; let r3 = 0; let genMiss = 0;
  for (const b of run.boundaries) {
    if (!b.deep || !UNIVERSE.some((f) => useful(f, b.modes, b.version))) continue;
    opportunities += 1;
    const fams = (c) => (familyOf(c) === 'composite' ? (c.metadata.parts ?? []).map(familyOf) : [familyOf(c)]);
    if (!b.considered.some((c) => fams(c).some((f) => f && useful(f, b.modes, b.version)))) genMiss += 1;
    const byId = new Map(b.considered.map((c) => [c.id, c]));
    const ranked = (b.decision.candidates ?? []).filter((c) => c.rank !== null && c.kind !== 'continue' && c.kind !== 'stop' && c.id !== DISCOVERY_ID)
      .sort((x, y) => x.rank - y.rank).slice(0, 3);
    if (ranked.some((s) => byId.has(s.id) && fams(byId.get(s.id)).some((f) => f && useful(f, b.modes, b.version)))) r3 += 1;
  }
  return { opportunities, r3, genMiss };
}

/** Oracle value of the first `k` carried interventions: masked re-run under
 *  the same gate and draws. Savings in tokens, success valued at the task. */
export function oracle(task, base, opts, k, world = cfg) {
  const out = [];
  for (const iv of base.w.interventions.slice(0, k)) {
    const masked = runTask(task, world, { ...opts, mask: iv.index });
    const savings = (masked.w.tokens - base.w.tokens)
      + ((base.w.outcome.succeeded ? 1 : 0) - (masked.w.outcome.succeeded ? 1 : 0)) * task.steps * task.tps;
    out.push({ kind: iv.kind, id: iv.id, version: iv.version, tokens: iv.tokens, savings });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Running a configuration
// ---------------------------------------------------------------------------

export function taskSet(perBucket = cfg.passB.tasksPerBucket) {
  return makeTaskSet(cfg, cfg.passB.seed, perBucket);
}

/**
 * One configuration over a chronological task stream, `reps` times.
 * @param conf.variant   'H0' | 'H2' | 'H3b' | 'H4' …
 * @param conf.gate      boundary thresholds for makeGate (or undefined)
 * @param conf.discovery discovery margin (undefined = today's rule)
 * @param conf.replay    { mode: 'as_is' | 'none' | 'gated', theta, maxReplays }
 * @param conf.calibrate true = chronological bin calibration of p_fail fed to
 *                       the market (H2 + learning flag with calibration only)
 */
export function runConfig(conf, tasks, { reps = cfg.passB.reps, oracleK = 3, split = cfg.learningSplit } = {}) {
  const runs = [];
  const replay = [];
  for (let rep = 0; rep < reps; rep++) {
    const memory = emptyGovernorMemory();
    const streamPool = createDormantPool();
    const history = new Map();
    const replayStats = { changes: 0, replays: 0, predicted: [], tokens: 0 };
    // The pre-registered regimes: H0 cold, H4 warm causal, the rest warm factual.
    const regime = conf.variant === 'H0' ? 'M0' : conf.variant === 'H4' ? 'M2' : 'M1';
    tasks.forEach((task, index) => {
      const window = index < split.train ? 'train' : index < split.train + split.adapt ? 'adapt' : 'heldout';
      const opts = { variant: conf.variant, rep, regime, history: regime === 'M0' ? null : history };
      if (conf.variant === 'H4') { opts.memory = memory; opts.pool = streamPool; }
      if (conf.calibrate) { opts.memory = memory; opts.features = { ...VARIANTS[conf.variant], learning: true }; }
      if (conf.gate) opts.gate = makeGate(conf.gate);
      else if (conf.variant !== 'H0') opts.gate = makeGate({});
      if (conf.discovery !== undefined) Object.assign(opts, discoveryGate(conf.discovery));
      const run = runTask(task, cfg, opts);
      const truth = conf.variant === 'H0' ? [] : oracle(task, run, opts, oracleK);
      let replayTokens = 0;
      if (conf.variant === 'H4' && window !== 'heldout') {
        replayTokens = learn(run, memory, streamPool, task, opts, conf.replay ?? { mode: 'as_is' }, replayStats);
      } else if (conf.calibrate && window !== 'heldout') {
        // Calibration only: what learnFromTask records about p_fail, from
        // production-visible outcomes, and nothing else.
        const scratch = emptyGovernorMemory();
        scratch.calibration = memory.calibration;
        learnFromTask({ trace: traceOf(run, []), memory: scratch, usdPerToken: PRICE, regime: task.bucket });
        memory.calibration = scratch.calibration;
      }
      if (regime !== 'M0' && run.w.outcome.validated) history.set(task.repo, (history.get(task.repo) ?? 0) + 1);
      runs.push(summarize(run, { rep, index, window, truth, replayTokens }));
    });
    replay.push(replayStats);
  }
  runs.replayStats = replay;
  return runs;
}

/** H4 learning with the replay executor wrapped by the replay gate.
 *  P(replay changes the lesson) is learned chronologically from earlier
 *  replays on this stream: a change is a replay whose effect sign differs from
 *  what memory believed before it (Level-1 effect, alternative vs chosen). */
function learn(run, memory, pool, task, opts, replay, stats) {
  const advice = new Map();
  for (const b of run.boundaries) for (const c of b.considered) if (typeof c.metadata.advice === 'string') advice.set(c.metadata.fingerprint ?? c.id, c.metadata.advice);
  const replayOpts = { ...opts, memory: emptyGovernorMemory(), mask: undefined };
  const executor = ({ packet, intervention, replays }) => {
    if (replay.mode === 'none') return [];
    const pattern = statePattern(packet);
    const before = memory.model.benefit(pattern, intervention.fingerprint).mean - memory.model.benefit(pattern, packet.chosen.fingerprint).mean;
    const pChange = (stats.changes + 1) / (stats.replays + 2);
    if (replay.mode === 'gated') {
      const frequency = (memory.model.seen(pattern) + 1) / (memory.sequence + 1);
      const stake = frequency * 100 * Math.max(0, intervention.opportunityRegret);
      if (pChange * stake < replay.theta * run.w.tokens) return [];
    }
    const n = Math.min(replays, replay.maxReplays ?? replays);
    const out = [];
    for (let k = 0; k < n; k++) {
      const candidate = actionCandidate({ id: intervention.fingerprint, kind: 'acquire_evidence', capability: intervention.capability,
        metadata: { fingerprint: intervention.fingerprint, ...(advice.get(intervention.fingerprint) ? { advice: advice.get(intervention.fingerprint) } : {}) } });
      const r = runTask(task, cfg, { ...replayOpts, gate: undefined, salt: `replay-${packet.stateVersion}-${k}`, force: { version: packet.stateVersion, candidate } });
      out.push({ succeeded: r.w.outcome.validated, tokens: r.w.tokens });
    }
    const effect = out.filter((o) => o.succeeded).length / out.length - (run.w.outcome.validated ? 1 : 0);
    const changed = Math.sign(effect) !== Math.sign(before) && !(effect === 0 && Math.abs(before) < 1e-9);
    stats.replays += 1; if (changed) stats.changes += 1;
    stats.predicted.push({ pChange, changed });
    return out;
  };
  const result = learnFromTask({ trace: { ...traceOf(run, pool.entries()), motifs: memory.motifs }, memory, pool, replay: executor, usdPerToken: PRICE, regime: task.bucket });
  stats.tokens += result.diagnosticTokens;
  return result.diagnosticTokens;
}

function summarize(run, extra) {
  const w = run.w;
  const applied = new Set(w.interventions.map((i) => i.version)).size;
  const tokens = w.tokens + extra.replayTokens;
  return {
    taskId: run.task.id, bucket: run.task.bucket, unavoidable: run.task.unavoidable, ...extra,
    success: w.outcome.succeeded, tokens, steps: w.step, autonomousSteps: w.step - applied,
    looks: run.boundaries.filter((b) => b.deep).length,
    selected: w.selected ?? 0, abstained: w.abstained ?? 0, carried: w.interventions.length,
    interventionTokens: w.interventionTokens, disruptionTokens: w.disruptionTokens, discoveryTokens: w.discoveryTokens,
    lookTokens: w.govTokens, recall: recallOf(run), preventionDebt: preventableDebt(run),
    calibration: run.packets.filter((p) => p.risk).map((p) => ({
      p: p.risk.immediateFailureProbability,
      y: w.trace.some((e) => e.version > p.stateVersion && e.kind === 'failure') || !w.outcome.validated ? 1 : 0,
    })),
  };
}

function preventableDebt(run) {
  let tokens = 0;
  for (const m of run.w.modes) {
    const preventable = UNIVERSE.some((f) => (m.special ? (TE[f].special ?? 0) : (TE[f].prevent?.[m.dim] ?? 0)) >= 0.25);
    if (!preventable) continue;
    if (['detected', 'fixed', 'abandoned'].includes(m.status)) tokens += (m.rework ?? 0) * run.task.tps;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Metrics, Pareto, paired bootstrap
// ---------------------------------------------------------------------------

export function metrics(runs, filter = () => true) {
  const rs = runs.filter(filter);
  const sum = (f) => rs.reduce((s, r) => s + f(r), 0);
  const n = rs.length || 1;
  const succ = sum((r) => (r.success ? 1 : 0));
  const truth = rs.flatMap((r) => r.truth);
  const ivTok = truth.reduce((s, t) => s + t.tokens, 0);
  const cal = rs.flatMap((r) => r.calibration);
  const rec = rs.reduce((a, r) => ({ o: a.o + r.recall.opportunities, r3: a.r3 + r.recall.r3, g: a.g + r.recall.genMiss }), { o: 0, r3: 0, g: 0 });
  return {
    runs: rs.length,
    success: succ / n,
    tokensPerTask: sum((r) => r.tokens) / n,
    tokensPerSuccess: sum((r) => r.tokens) / Math.max(1, succ),
    looksPerTask: sum((r) => r.looks) / n,
    selectedPerTask: sum((r) => r.selected) / n,
    abstainedPerTask: sum((r) => r.abstained) / n,
    interventionsPerTask: sum((r) => r.carried) / n,
    autonomy: sum((r) => r.autonomousSteps) / Math.max(1, sum((r) => r.steps)),
    zeroInterventionTasks: rs.filter((r) => r.carried === 0).length / n,
    interventionPrecision: truth.length ? truth.filter((t) => t.savings > 0).length / truth.length : null,
    interventionROI: ivTok > 0 ? truth.reduce((s, t) => s + t.savings, 0) / ivTok : null,
    netSavingPerLabelled: truth.length ? truth.reduce((s, t) => s + t.savings, 0) / truth.length : null,
    interventionTokensPerTask: sum((r) => r.interventionTokens) / n,
    controlFrictionPerTask: sum((r) => r.disruptionTokens + r.lookTokens) / n,
    discoveryTokensPerTask: sum((r) => r.discoveryTokens) / n,
    replayTokensPerTask: sum((r) => r.replayTokens) / n,
    candidateRecall3: rec.o ? rec.r3 / rec.o : null,
    generationMissRate: rec.o ? rec.g / rec.o : null,
    preventionDebtPerTask: sum((r) => r.preventionDebt) / n,
    unavoidableInterventions: sum((r) => (r.unavoidable ? r.carried : 0)) / Math.max(1, rs.filter((r) => r.unavoidable).length),
    brier: cal.length ? cal.reduce((s, c) => s + (c.p - c.y) ** 2, 0) / cal.length : null,
    meanP: cal.length ? cal.reduce((s, c) => s + c.p, 0) / cal.length : null,
    meanY: cal.length ? cal.reduce((s, c) => s + c.y, 0) / cal.length : null,
  };
}

/** Non-dominated points on (tokens/success ↓, success ↑). */
export function pareto(points) {
  return points.filter((a) => !points.some((b) => b !== a
    && b.m.tokensPerSuccess <= a.m.tokensPerSuccess && b.m.success >= a.m.success
    && (b.m.tokensPerSuccess < a.m.tokensPerSuccess || b.m.success > a.m.success)));
}

/** Paired bootstrap over tasks (reps averaged): CPS ratio delta and success
 *  delta of `b` against `a`, as the pre-registered analysis does it. */
export function pairedDelta(a, b, filter = () => true, resamples = cfg.bootstrap.resamples) {
  const agg = (runs) => {
    const m = new Map();
    for (const r of runs.filter(filter)) {
      const e = m.get(r.taskId) ?? { t: 0, s: 0, n: 0 };
      e.t += r.tokens; e.s += r.success ? 1 : 0; e.n += 1; m.set(r.taskId, e);
    }
    return m;
  };
  const A = agg(a); const B = agg(b);
  const ids = [...A.keys()].filter((k) => B.has(k)).sort();
  const stat = (sample) => {
    let ta = 0, sa = 0, tb = 0, sb = 0, n = 0;
    for (const id of sample) { ta += A.get(id).t; sa += A.get(id).s; tb += B.get(id).t; sb += B.get(id).s; n += A.get(id).n; }
    return { cps: (tb / Math.max(1, sb)) / (ta / Math.max(1, sa)) - 1, succ: (sb - sa) / Math.max(1, n) };
  };
  const point = stat(ids);
  const cps = []; const succ = [];
  for (let i = 0; i < resamples; i++) {
    const sample = ids.map((_, j) => ids[Math.floor(hashUnit(cfg.bootstrap.seed, i, j) * ids.length)]);
    const s = stat(sample); cps.push(s.cps); succ.push(s.succ);
  }
  const q = (xs, p) => [...xs].sort((x, y) => x - y)[Math.floor(p * (xs.length - 1))];
  return { cps: point.cps, cpsCI: [q(cps, 0.025), q(cps, 0.975)], success: point.succ, successCI: [q(succ, 0.025), q(succ, 0.975)], tasks: ids.length };
}
