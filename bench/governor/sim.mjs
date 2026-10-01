// Arm A of the governor benchmark: a stochastic agent world governed by the
// real compiled governor (dist/). See PREREGISTRATION.md.
//
// What the governor sees is built exactly as `economicStateFor` builds it in
// production (same uncertainty mapping, compareTrajectory, allocateBudget
// reserve, recovery source, evidence-read candidates). What it never sees is
// the world's ground truth: latent failure modes and true intervention effects.
import { createHash } from 'node:crypto';
import { initialEconomicState, normalizeEconomicState } from '../../dist/decision/state.js';
import { compareTrajectory, EMPTY_SNAPSHOT } from '../../dist/decision/trajectory.js';
import { runDecisionCycle, INITIAL_CADENCE } from '../../dist/decision/orchestration-loop.js';
import { actionCandidate } from '../../dist/decision/actions.js';
import { allocateBudget } from '../../dist/decision/budget.js';
import { stateDerivedCandidates, registerCandidateSource } from '../../dist/decision/deep-path.js';
import { evaluateRecovery, recoveryCandidate } from '../../dist/recovery/engine.js';
import { clearPredictionCache, candidateFingerprint } from '../../dist/decision/transition.js';
import { createGovernorContext, newGovernorNodeState, learnFromTask, VARIANTS } from '../../dist/governor/governor.js';
import { memoryPacketStore } from '../../dist/governor/packet.js';
import { analyzeTask } from '../../dist/governor/miss.js';
import { partsOf } from '../../dist/governor/contracts.js';
import { DORMANT_REGISTRY } from '../../dist/governor/coverage.js';

// ---------------------------------------------------------------------------
// Deterministic randomness (common random numbers across variants)
// ---------------------------------------------------------------------------

export function hashUnit(...parts) {
  const h = createHash('sha256').update(parts.join('|')).digest();
  return h.readUInt32BE(0) / 2 ** 32;
}
const normal = (...parts) => {
  const u1 = Math.max(1e-12, hashUnit(...parts, 'a'));
  const u2 = hashUnit(...parts, 'b');
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};
const between = (lo, hi, ...parts) => lo + Math.floor(hashUnit(...parts) * (hi - lo + 1));
function pick(weights, ...parts) {
  const u = hashUnit(...parts);
  let acc = 0;
  const entries = Object.entries(weights);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  for (const [k, w] of entries) { acc += w / total; if (u < acc) return k; }
  return entries.at(-1)[0];
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const BUCKETS = ['local', 'multi', 'exploratory', 'risky'];

/** One latent task. `over` lets a stress set skew the generator. */
export function makeTask(cfg, seed, index, bucket, over = {}) {
  const W = cfg.world;
  const b = { ...W.buckets[bucket], ...(over.bucket ?? {}) };
  const id = `${seed}-${bucket}-${index}`;
  const long = over.long ?? hashUnit(id, 'long') < W.longHorizonShare;
  const [lo, hi] = b.steps;
  const steps = Math.round(between(lo, hi, id, 'steps') * (long ? W.longHorizonFactor : 1));
  const anchored = hashUnit(id, 'anchored') < b.anchored;
  const tps = W.tokensPerStepMedian * Math.exp(W.tokensPerStepSigma * normal(id, 'tps'));
  const modeCount = over.modes ?? (hashUnit(id, 'hasModes') < b.modeRate ? between(1, b.maxModes, id, 'nmodes') : 0);
  const modes = [];
  for (let m = 0; m < modeCount; m++) {
    const special = over.special ?? hashUnit(id, m, 'special') < b.special;
    const dim = special ? 'behavioral' : pick(b.dims, id, m, 'dim');
    modes.push({
      id: m, dim, special,
      onset: Math.max(1, Math.round(hashUnit(id, m, 'onset') * 0.7 * steps)),
      lag: between(b.lag[0], b.lag[1], id, m, 'lag'),
      hidden: over.hidden ?? hashUnit(id, m, 'hidden') < b.hidden,
      severity: 0.6 + 0.8 * hashUnit(id, m, 'severity'),
    });
  }
  const files = anchored ? between(1, 3, id, 'files') : between(3, 6, id, 'files');
  return {
    id, bucket, long, steps, anchored, tps, modes, files,
    repo: `repo-${Math.floor(hashUnit(id, 'repo') * W.repos)}`,
    unavoidable: over.unavoidable ?? hashUnit(id, 'unavoidable') < W.unavoidableShare,
    selfCatch: b.selfCatch, flail: b.flail,
  };
}

export function makeTaskSet(cfg, seed, perBucket, over = {}) {
  const out = [];
  for (let i = 0; i < perBucket; i++) for (const bucket of (over.buckets ?? BUCKETS)) out.push(makeTask(cfg, seed, i, bucket, over));
  // Chronological order is a fixed shuffle of the set.
  return out.sort((a, b) => hashUnit(seed, a.id, 'order') - hashUnit(seed, b.id, 'order'));
}

// ---------------------------------------------------------------------------
// Production-identical state construction
// ---------------------------------------------------------------------------

const TURN_CAP = 60;
const ASSUMED_TOKENS_PER_TURN = 8_000;

function snapshotOf(w) {
  return {
    sequence: w.step, tokensConsumed: w.tokens,
    activeTargets: [...w.edited].sort(), searchTargets: [...w.searches].sort(),
    failureSignatures: [...w.failureLog], knownEvidence: [...w.evidence].sort(),
    validationStatus: w.validation.status,
    productiveActions: w.productive, totalActions: w.step,
  };
}

/** `economicStateFor`, with the simulated stream in place of the events table. */
function economicState(w, task, cfg) {
  const snapshot = snapshotOf(w);
  const trajectory = compareTrajectory(w.prevSnapshot, snapshot);
  w.prevSnapshot = snapshot;
  // task-economics signals (anchors only; readOnly false): see
  // efficiency/task-economics.ts
  const confidence = Math.min(1, 0.4 + (task.anchored ? 0.35 : 0) + (task.anchored && task.files === 1 ? 0.1 : 0));
  const doubt = 1 - confidence;
  const tokensPerTurn = w.step > 0 ? w.tokens / w.step : ASSUMED_TOKENS_PER_TURN;
  const totalTokenBudget = Math.max(w.tokens, Math.round(TURN_CAP * tokensPerTurn));
  const base = initialEconomicState({
    goal: task.id, repository: task.repo, repositoryRevision: `${task.repo}@1`,
    totalTokenBudget, validationRequired: true,
  });
  const evidence = [...w.edited].map((t) => ({ id: `observed:${t}`, kind: 'fact', source: `run:${t}`, confidence: 0.9 }))
    .concat([...w.searches].map((t) => ({ id: `observed:${t}`, kind: 'observation', source: `run:${t}`, confidence: 0.6 })));
  const state = normalizeEconomicState({
    ...base,
    version: w.step,
    evidence,
    uncertainty: {
      target: doubt,
      structural: Math.max(0, (task.anchored ? doubt * 0.5 : doubt) - trajectory.informationGain),
      behavioral: 1 - confidence,
      validation: w.validation.status === 'passed' ? 0 : Math.max(0, 0.8 - w.validation.confidence),
    },
    resources: { ...base.resources, consumedTokens: w.tokens, usdPerToken: cfg.usdPerToken },
    trajectory: {
      progress: trajectory.progress, informationGain: trajectory.informationGain,
      explorationPressure: trajectory.explorationPressure, failurePressure: trajectory.failurePressure,
      stateSimilarity: trajectory.stateSimilarity,
      orchestrationConfidence: Math.min(confidence, Math.min(1, w.step / 5)),
    },
    validation: { ...w.validation },
  });
  return state;
}

/** The boundary's own candidates (`evidenceCandidates`, `recoveryCandidates`)
 *  and the reserve (`withReserves`), as economic-runtime.ts builds them. */
function boundaryCandidates(w, task, state) {
  const out = [];
  const unread = [];
  for (let f = 0; f < task.files; f++) if (!w.read.has(f)) unread.push(f);
  if (state.uncertainty.structural > 0 && unread.length > 0) {
    const f = unread[0];
    const tokens = Math.round(0.3 * task.tps);
    out.push(actionCandidate({
      id: `evidence:file-${f}`, kind: 'acquire_evidence', capability: 'evidence.read-file',
      expectedTokenBenefit: Math.max(0, 0.5 * task.tps + tokens), tokenCost: tokens, qualityRisk: 0,
      expectedInformationGain: state.uncertainty.structural, confidence: state.trajectory.orchestrationConfidence,
      metadata: { path: `file-${f}`, source: 'context-selection', representation: 'full', addresses: ['structural'] },
    }));
  }
  const failing = w.modes.find((m) => m.status === 'detected');
  if (failing) {
    const evaluation = evaluateRecovery({ state, failureSignature: `fail:${failing.id}`, tombstones: w.tombstones });
    if (evaluation.justified) {
      const c = recoveryCandidate(evaluation, state);
      out.push({ ...c, metadata: { ...c.metadata, failureSignature: `fail:${failing.id}` } });
    }
  }
  const allocation = allocateBudget({ state, opportunities: [...stateDerivedCandidates(state), ...out] });
  const reserve = allocation.recoveryReserve + allocation.validation;
  const reserved = reserve > 0 ? normalizeEconomicState({ ...state, resources: { ...state.resources, recoveryReserve: reserve } }) : state;
  return { candidates: out, state: reserved };
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

function freshWorld(task) {
  return {
    step: 0, units: 0, needUnits: task.steps, tokens: 0, agentTokens: 0, govTokens: 0,
    interventionTokens: 0, disruptionTokens: 0, discoveryTokens: 0, latencyMs: 0, marketMs: 0,
    productive: 0, edited: new Set(), searches: new Set(), failureLog: [], evidence: new Set(), read: new Set(),
    validation: { required: true, confidence: 0, status: 'unknown' },
    modes: task.modes.map((m) => ({ ...m, status: 'pending', fixBoost: 0, detectedAt: null })),
    prevSnapshot: EMPTY_SNAPSHOT, tombstones: [], reworkReduce: 0, interventions: [], proposalsAccepted: 0,
    invited: false, trace: [], outcome: null, cadence: INITIAL_CADENCE, flailTerm: null, staleModes: 0,
    boundaryLog: [],
  };
}

function trueEffectOf(candidate, cfg) {
  const T = cfg.world.trueEffects;
  const fp = typeof candidate.metadata.fingerprint === 'string' ? candidate.metadata.fingerprint : candidate.id;
  if (T[fp]) return { key: fp, ...T[fp], advice: true };
  if (candidate.id.startsWith('evidence:')) return { key: 'context-read', ...T['context-read'], advice: false };
  if (candidate.kind === 'recover') return { key: 'recover', ...T.recover, advice: false };
  if (candidate.id.startsWith('historical:')) return { key: 'historical', ...T.historical, advice: false };
  if (candidate.id.startsWith('proposal:')) {
    const special = candidate.metadata.advice?.toLowerCase().includes('callers');
    return { key: special ? 'proposal:special' : 'proposal:noise', ...T[special ? 'proposal:special' : 'proposal:noise'], advice: true };
  }
  // deep:validate / deep:constrain / governor:discover: recorded, not carried
  // out — exactly as in production.
  return null;
}

/** Carries out one decision in the world. Returns tokens it cost. */
function carryOut(w, task, decision, cfg, salt) {
  const W = cfg.world;
  let spent = 0;
  for (const part of partsOf(decision.action)) {
    const eff = trueEffectOf(part, cfg);
    if (!eff) continue;
    const rng = (k) => hashUnit(task.id, salt, w.step, part.id, k);
    if (eff.advice && rng('follow') >= W.adviceFollow) continue;
    const cost = eff.cost * task.tps;
    const disruption = eff.advice ? W.disruptionSteps * task.tps : 0;
    w.interventionTokens += cost; w.disruptionTokens += disruption; spent += cost + disruption;
    if (part.id.startsWith('proposal:')) w.proposalsAccepted += 1;
    for (const m of w.modes) {
      if (m.status === 'pending') {
        const p = m.special ? (eff.special ?? 0) : (eff.prevent?.[m.dim] ?? 0);
        if (p > 0 && rng(`prevent-${m.id}`) < p) m.status = 'prevented';
      } else if (m.status === 'active' && !m.hidden && eff.detect && rng(`detect-${m.id}`) < eff.detect) {
        detect(w, m, task);
      }
      if (m.status === 'detected' && eff.fixBoost) m.fixBoost = eff.fixBoost;
    }
    if (eff.saveSteps) {
      const relevant = eff.relevant === undefined || rng('relevant') < eff.relevant;
      if (relevant) w.needUnits = Math.max(w.units + 1, w.needUnits - eff.saveSteps);
    }
    if (eff.stale && rng('stale') < eff.stale) {
      w.modes.push({ id: 100 + w.staleModes++, dim: 'structural', special: false, onset: w.step + 1, lag: 3, hidden: false, severity: 0.8, status: 'pending', fixBoost: 0, detectedAt: null });
    }
    if (eff.reworkReduce) w.reworkReduce = eff.reworkReduce;
    if (part.id.startsWith('evidence:')) w.read.add(Number(part.id.split('-').at(-1)));
    if (part.kind === 'recover' && part.metadata.failureSignature) w.tombstones.push({ id: `${task.id}:${w.step}`, failureSignature: part.metadata.failureSignature, invalidatedEvidenceIds: [], retainedEvidenceIds: [], tokensSpent: w.tokens, expectedCost: part.tokenCost, reasonCodes: [] });
  }
  return spent;
}

function detect(w, m, task) {
  m.status = 'detected';
  m.detectedAt = w.step;
  const commit = Math.min(1, w.units / Math.max(1, w.needUnits));
  const rework = Math.ceil(Math.max(1, w.step - m.onset) * m.severity * (1 + 0.5 * commit) * (1 - w.reworkReduce));
  w.reworkReduce = 0;
  m.rework = rework;
  w.needUnits += rework;
  w.validation = { required: true, confidence: 1, status: 'failed' };
  w.trace.push({ version: w.step, kind: 'failure', signature: `fail:${m.id}`, tokens: 0 });
}

/** The agent's own step: fully autonomous; the governor never chooses it. */
function agentStep(w, task, cfg, salt) {
  const W = cfg.world;
  const rng = (k) => hashUnit(task.id, salt, w.step, k);
  w.step += 1;
  const tokens = task.tps * Math.exp(W.stepNoiseSigma * normal(task.id, salt, w.step, 'tok') - W.stepNoiseSigma ** 2 / 2);
  w.agentTokens += tokens; w.tokens += tokens; w.latencyMs += W.stepLatencyMs;

  for (const m of w.modes) {
    if (m.status === 'pending' && w.step >= m.onset) m.status = 'active';
    if (m.status === 'active') {
      if (rng(`self-${m.id}`) < task.selfCatch) {
        m.status = 'selfcaught';
        w.needUnits += Math.ceil(Math.max(1, w.step - m.onset) * 0.5);
      } else if (!m.hidden && w.step >= m.onset + m.lag) {
        detect(w, m, task);
      }
    }
  }

  const detected = w.modes.filter((m) => m.status === 'detected');
  if (detected.length > 0) {
    // Working the failure: repeated signature, a fix attempt.
    for (const m of detected) {
      w.failureLog.push(`fail:${m.id}`);
      if (rng(`fix-${m.id}`) < cfg.world.pFix + m.fixBoost) {
        m.status = 'fixed'; m.fixBoost = 0;
        w.trace.push({ version: w.step, kind: 'recovery', fingerprint: 'agent:self-fix', capability: 'agent', tokens: 0 });
        if (!w.modes.some((x) => x.status === 'detected')) w.validation = { required: true, confidence: 0.5, status: 'pending' };
      } else if (w.step - m.detectedAt > cfg.world.giveUpLagMultiple * Math.max(2, m.lag)) {
        m.status = 'abandoned';
      }
    }
    w.units += 0.5; w.productive += 0.5;
    return;
  }

  const flailing = w.modes.some((m) => m.status === 'active' && (m.dim === 'structural' || m.dim === 'behavioral'));
  if (flailing && rng('flail') < task.flail) {
    w.flailTerm ??= `search-${w.step}`;
    w.searches.add(w.flailTerm);
    return;
  }
  w.flailTerm = null;
  if (rng('productive') < W.pProductive) {
    w.units += 1; w.productive += 1;
    w.edited.add(`file-${Math.floor(rng('which') * task.files)}`);
  } else {
    w.searches.add(`search-${w.step}`);
    w.evidence.add(`ev-${w.step}`);
  }
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

/**
 * @param opts.variant   'H0'…'H4'
 * @param opts.memory    GovernorMemory or null (H4 learning store)
 * @param opts.pool      dormant pool shared by the stream
 * @param opts.regime    'M0' | 'M1' | 'M2'
 * @param opts.history   per-repo factual memory for M1/M2: Map repo → count
 * @param opts.mask      index of the intervention to skip carrying out (oracle)
 * @param opts.force     { version, candidate } to carry out at a boundary (replay)
 * @param opts.salt      exogenous-noise salt (replays use a different one)
 */
export function runTask(task, cfg, opts) {
  clearPredictionCache();
  const W = cfg.world;
  const salt = opts.salt ?? `rep${opts.rep ?? 0}`;
  const w = freshWorld(task);
  const features = opts.variant === 'H0' ? null : VARIANTS[opts.variant];
  const packets = memoryPacketStore();
  const node = newGovernorNodeState();
  const ctx = features ? createGovernorContext({
    taskId: task.id, features, packets,
    ...(opts.memory ? { memory: opts.memory } : {}),
    ...(opts.pool ? { pool: opts.pool } : {}),
  }) : null;
  const expected = task.steps * task.tps;
  const budget = W.budgetMultiple * expected;
  let interventionIndex = 0;
  const boundaries = [];
  const history = opts.history;
  let unregister = null;
  if (features && history && (opts.regime === 'M1' || opts.regime === 'M2')) {
    const known = history.get(task.repo) ?? 0;
    unregister = registerCandidateSource('historical-evidence', (state) => {
      if (known <= 0 || state.uncertainty.structural <= 0) return [];
      return Array.from({ length: Math.min(2, known) }, (_, k) => actionCandidate({
        id: `historical:${task.repo}:${k}`, kind: 'reuse_evidence', capability: 'evidence.store',
        expectedTokenBenefit: task.tps, tokenCost: Math.round(0.1 * task.tps), qualityRisk: 0.15,
        expectedInformationGain: state.uncertainty.structural * 0.85, confidence: state.trajectory.orchestrationConfidence * 0.85,
        metadata: { addresses: ['structural'], knowledgeId: `${task.repo}:${k}` },
      }));
    });
  }

  try {
    let finalChecks = 0;
    while (true) {
      // ---- boundary: the governor may look --------------------------------
      if (features) {
        const raw = economicState(w, task, cfg);
        const { candidates, state } = boundaryCandidates(w, task, raw);
        if (w.invited && !node.invitationSent) node.invitationSent = true;
        const t0 = performance.now();
        const cycle = runDecisionCycle(state, { cadence: w.cadence, additionalCandidates: candidates, governor: { ctx, node } });
        w.marketMs += performance.now() - t0;
        w.cadence = cycle.cadence;
        if (node.inviteProposals && !w.invited) w.invited = true;
        const decision = cycle.decision;
        if (cycle.cost.reason !== 'not_due' && decision) {
          boundaries.push({
            version: w.step, decision, deep: !cycle.skippedDeepEvaluation, considered: cycle.candidates,
            remaining: state.resources.remainingTokens,
            modes: w.modes.map((m) => ({ dim: m.dim, special: m.special, status: m.status, onset: m.onset, hidden: m.hidden })),
          });
          w.govTokens += cycle.cost.tokens;
        }
        if (cycle.governed?.discovery) {
          const d = cycle.governed.discovery;
          // Registry retrieval is arithmetic; the agent tier costs its prompt line.
          w.discoveryTokens += d.tier === 'agent_proposal' ? 400 : d.tier === 'semantic' ? 667 : 0;
        }
        let act = decision && decision.action.kind !== 'continue' && decision.action.kind !== 'stop' ? decision : null;
        if (opts.force && opts.force.version === w.step) act = { ...decision, action: opts.force.candidate };
        if (act) {
          const index = interventionIndex++;
          if (opts.mask !== index) {
            const spent = carryOut(w, task, act, cfg, salt);
            w.tokens += spent;
            if (spent > 0) {
              w.interventions.push({ version: w.step, index, id: act.action.id, kind: act.action.kind, utility: act.utility, tokens: spent });
              w.trace.push({ version: w.step, kind: act.action.kind === 'recover' ? 'recovery' : 'intervention',
                fingerprint: candidateFingerprint(act.action), capability: act.action.capability,
                addresses: act.action.metadata.addresses ?? [], tokens: spent });
            }
          }
        }
      }

      // ---- the agent, autonomous -----------------------------------------
      // Proposals the invitation produced, on the step after it went out.
      if (w.invited && !w.proposed) {
        w.proposed = true;
        const special = w.modes.find((m) => m.special && m.status === 'pending');
        const raw = [];
        if (special && hashUnit(task.id, salt, 'know') < W.proposals.knowSpecial) {
          raw.push({ description: 'Inspect the historical callers of the symbol you are changing before modifying it', addresses: ['behavioral'] });
        }
        if (hashUnit(task.id, salt, 'noise') < W.proposals.noise) raw.push({ description: 'Re-read the task statement before continuing', addresses: ['target'] });
        node.pendingProposals.push(...raw);
        w.tokens += 150; w.discoveryTokens += 150;
      }
      agentStep(w, task, cfg, salt);

      const unresolved = w.modes.some((m) => m.status === 'detected');
      const abandoned = w.modes.some((m) => m.status === 'abandoned');
      if (abandoned || w.tokens > budget || w.step > W.maxStepMultiple * task.steps + 20) {
        w.outcome = { succeeded: false, validated: false, reason: abandoned ? 'abandoned' : 'budget' };
        break;
      }
      if (w.units >= w.needUnits && !unresolved) {
        // The agent's own final check catches what has not been caught.
        const latent = w.modes.filter((m) => m.status === 'active' && !m.hidden);
        if (latent.length > 0 && finalChecks < 3) { finalChecks += 1; for (const m of latent) detect(w, m, task); continue; }
        if (task.unavoidable) { w.outcome = { succeeded: false, validated: false, reason: 'unavoidable' }; break; }
        const hiddenFailure = w.modes.some((m) => m.status === 'active' && m.hidden);
        w.validation = { required: true, confidence: 1, status: 'passed' };
        w.trace.push({ version: w.step, kind: 'validation', passed: true, tokens: 0 });
        w.outcome = { succeeded: !hiddenFailure, validated: true, hiddenFailure, reason: hiddenFailure ? 'hidden' : 'ok' };
        break;
      }
    }
  } finally {
    unregister?.();
  }

  const reworkTokens = w.modes.reduce((s, m) => s + (m.rework ?? 0), 0) * task.tps;
  const packetList = packets.list(task.id);
  return {
    task, w, node, packets: packetList, boundaries, reworkTokens,
    governorOverheadTokens: w.interventionTokens + w.disruptionTokens + w.discoveryTokens,
  };
}

/** The miss-engine trace for a finished run, from production-visible facts. */
export function traceOf(run, pool) {
  return {
    taskId: run.task.id,
    packets: run.packets,
    events: [...run.w.trace].sort((a, b) => a.version - b.version),
    pool,
    motifs: [],
    outcome: {
      succeeded: run.w.outcome.validated, totalTokens: run.w.tokens, reworkTokens: run.reworkTokens,
    },
    sourceCapabilities: [...new Set(run.packets.flatMap((p) => p.candidates.map((c) => c.capability)))],
  };
}

export { learnFromTask, analyzeTask, DORMANT_REGISTRY };
