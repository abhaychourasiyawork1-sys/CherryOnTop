/** The Economic Governor: the order in which the harness decides whether
 *  governing is worth buying, and what it learns afterwards.
 *
 *  It is not a planner and not a chooser. The frontier agent owns cognition;
 *  `chooseEconomicAction` owns every final choice. The governor owns the
 *  *economics around* that choice, in this order (plan §26):
 *
 *    1. hard safety/authority/feasibility checks           (the market's own)
 *    2. cheap System-0 signals: risk, velocity, commitment
 *    3. the autonomy horizon: is a look due at all?
 *    4. the known candidates, priced against downstream loss
 *    5. action-space uncertainty
 *    6. discovery value low  → the market chooses among known options
 *    7. discovery value high → discovery becomes a candidate like any other
 *    8. System-1 only when its information value exceeds its cost (lifecycle)
 *    9. the market chooses the final harness action
 *   10. the agent resumes
 *
 *  Every mechanism is a feature that can be switched off for ablation; with all
 *  of them off this is exactly the market the branch already had. Learning
 *  (`learnFromTask`) runs after a task ends and changes only priors and
 *  estimates for future decisions — it never overrides the market. */
import { randomUUID } from 'node:crypto';
import type { ActionCandidate, ActionDecision } from '../decision/actions.js';
import type { EconomicState } from '../decision/state.js';
import { chooseEconomicAction, type EconomicDecisionInput } from '../decision/engine.js';
import { usdPerToken } from '../decision/utility.js';
import type { DecisionFault } from '../decision/utility.js';
import { candidateFingerprint } from '../decision/transition.js';
import { riskSnapshot, riskValuation, preventionValue, commitmentDepth, type RiskSnapshot, type PreventionTiming } from './risk.js';
import { composeCandidates, partsOf, compose } from './contracts.js';
import {
  actionSpaceUncertainty, settleCoverage, discoveryCandidate, createDormantPool, normalizeProposals,
  DISCOVERY_ID, compatibility, type CandidateSourceCoverage, type DormantPool, type DiscoveryTier, type DormantCandidate,
} from './coverage.js';
import { autonomyHorizon, premiseOf, materialTransition, type AutonomyHorizon, type HorizonPremise } from './horizon.js';
import { buildDecisionPacket, type DecisionPacket, type PacketStore } from './packet.js';
import {
  statePattern, refreshModel, updateMotifs, motifPrior, recalibrator, emptyGovernorMemory,
  type GovernorMemory, type CausalExperience, type CalibrationObservation, type MotifObservation,
} from './memory.js';
import { analyzeTask, type TaskTrace, type MissAnalysis } from './miss.js';
import { diagnose, type ReplayExecutor, type DiagnosisResult } from './ladder.js';

// ---------------------------------------------------------------------------
// Features and variants
// ---------------------------------------------------------------------------

export interface GovernorFeatures {
  /** Risk state, velocity, exposure, prevention frontier (H2). */
  risk: boolean;
  /** Option exposure modulating information value (H2). */
  option: boolean;
  /** Action-space uncertainty, dormant pool, discovery as a candidate (H3a). */
  discovery: boolean;
  /** The agent / System-1 proposal lane (H3a). */
  proposals: boolean;
  /** Bounded SEQ/PAR composition (H3b). */
  composition: boolean;
  /** Economically priced autonomy horizon instead of the backoff (H4). */
  adaptiveHorizon: boolean;
  /** Miss engine, counterfactual ladder, causal memory, motifs, calibration (H4). */
  learning: boolean;
}

export const NO_FEATURES: GovernorFeatures = {
  risk: false, option: false, discovery: false, proposals: false, composition: false, adaptiveHorizon: false, learning: false,
};

/** The benchmark's variants (benchmarking plan §1, §12). H0 is "no governor
 *  intervention at all" and is represented as null: the runtime never asks. */
export const VARIANTS: Record<string, GovernorFeatures | null> = {
  H0: null,
  H1: { ...NO_FEATURES },
  H2: { ...NO_FEATURES, risk: true, option: true },
  H3a: { ...NO_FEATURES, risk: true, option: true, discovery: true, proposals: true },
  H3b: { ...NO_FEATURES, risk: true, option: true, discovery: true, proposals: true, composition: true },
  'H3+AH': { ...NO_FEATURES, risk: true, option: true, discovery: true, proposals: true, composition: true, adaptiveHorizon: true },
  H4: { risk: true, option: true, discovery: true, proposals: true, composition: true, adaptiveHorizon: true, learning: true },
};
VARIANTS.H3 = VARIANTS.H3b;

/** The production default is the full architecture. `ORG_GOVERNOR_ABLATION`
 *  exists for the benchmark alone — it names a variant, never a pathway that
 *  production code branches on elsewhere. */
export function governorVariantFromEnv(): { name: string; features: GovernorFeatures | null } {
  const name = process.env.ORG_GOVERNOR_ABLATION?.trim();
  if (name && name in VARIANTS) return { name, features: VARIANTS[name] };
  return { name: 'H4', features: VARIANTS.H4 };
}

export function featureNames(features: GovernorFeatures): string[] {
  return (Object.keys(features) as Array<keyof GovernorFeatures>).filter((k) => features[k]);
}

// ---------------------------------------------------------------------------
// Per-run state and context
// ---------------------------------------------------------------------------

export interface AutonomyStats {
  boundaries: number;
  evaluations: number;
  interventions: number;
  /** Boundaries skipped because no look was due — the agent left alone. */
  autonomousBoundaries: number;
  horizons: number[];
  discoveries: number;
  discoveryTokens: number;
  compositionsBuilt: number;
  marketRuns: number;
  marketLatencyMs: number;
  packetBytes: number;
}

export interface GovernorNodeState {
  prevRisk: RiskSnapshot | null;
  horizon: AutonomyHorizon | null;
  premise: HorizonPremise | null;
  /** Proposals the agent made since the last boundary, raw. */
  pendingProposals: unknown[];
  /** Set when discovery bought the agent-proposal tier; the next dispatch
   *  carries the invitation, once. */
  inviteProposals: boolean;
  /** The invitation goes out once per run, then never again. */
  invitationSent: boolean;
  /** Advice already given on this run, by fingerprint → state version. Not
   *  offered again until a material transition makes it a new question. */
  advised: Map<string, number>;
  /** The last state version at which the premise changed materially. */
  lastMaterialVersion: number;
  stats: AutonomyStats;
}

export function newGovernorNodeState(): GovernorNodeState {
  return {
    prevRisk: null, horizon: null, premise: null, pendingProposals: [], inviteProposals: false, invitationSent: false,
    advised: new Map(), lastMaterialVersion: -1,
    stats: {
      boundaries: 0, evaluations: 0, interventions: 0, autonomousBoundaries: 0, horizons: [], discoveries: 0,
      discoveryTokens: 0, compositionsBuilt: 0, marketRuns: 0, marketLatencyMs: 0, packetBytes: 0,
    },
  };
}

export interface GovernorContext {
  features: GovernorFeatures;
  memory: GovernorMemory;
  packets: PacketStore | null;
  pool: DormantPool;
  taskId: string;
  /** Bounded System-1 semantic expansion, when a provider can do it. */
  semanticExpander?: (state: EconomicState, known: ActionCandidate[]) => ActionCandidate[];
  nowMs?: () => number;
  /** Packet provenance. */
  modelFingerprint?: string | null;
  harnessFingerprint?: string | null;
  policyVersion?: string | null;
}

export function createGovernorContext(over: Partial<GovernorContext> & { taskId: string; features: GovernorFeatures }): GovernorContext {
  return {
    memory: over.memory ?? emptyGovernorMemory(),
    packets: over.packets ?? null,
    pool: over.pool ?? createDormantPool(),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The governed decision
// ---------------------------------------------------------------------------

/** Whether a look is due. With the adaptive horizon: when the priced horizon
 *  ran out or the premise it was priced on changed. Without it, the caller's
 *  cadence decides (the backoff the loop already had). */
export function lookDue(state: EconomicState, node: GovernorNodeState): boolean {
  if (!node.horizon) return true;
  return state.version >= node.horizon.dueAtVersion || materialTransition(node.premise, state);
}

export interface GovernedDecision {
  decision: ActionDecision;
  packet: DecisionPacket | null;
  risk: RiskSnapshot | null;
  horizon: AutonomyHorizon | null;
  coverage: CandidateSourceCoverage[];
  discovery: { tier: DiscoveryTier; activated: string[] } | null;
  /** Every candidate considered in the final market run. */
  candidates: ActionCandidate[];
  prevention: Record<string, PreventionTiming>;
  actionSpaceUncertainty: number;
  compositions: number;
}

/** System-0's view of the run, computed whenever the governor looks — even
 *  when the screen finds nothing — because velocity is a difference and the
 *  horizon is priced from it. Cheap: arithmetic over the state. */
export function observeRisk(state: EconomicState, ctx: GovernorContext, node: GovernorNodeState): RiskSnapshot | null {
  if (!ctx.features.risk) return null;
  const recal = ctx.features.learning ? recalibrator(ctx.memory.calibration, 'failure') : undefined;
  return riskSnapshot(state, node.prevRisk, 0, recal);
}

/** Steps 4–9: price what is known, maybe buy discovery, maybe compose, and
 *  let the market choose. The market may run twice — once on what is known,
 *  once more if discovery or composition put something new on the table — and
 *  the second run is the decision. */
export function governDecision(input: {
  state: EconomicState;
  candidates: ActionCandidate[];
  coverage: CandidateSourceCoverage[];
  faults?: readonly DecisionFault[];
  risk: RiskSnapshot | null;
  ctx: GovernorContext;
  node: GovernorNodeState;
  estimates?: EconomicDecisionInput['estimates'];
  executable?: EconomicDecisionInput['executable'];
}): GovernedDecision {
  const { state, ctx, node } = input;
  const f = ctx.features;
  const now = ctx.nowMs ?? Date.now;
  const pattern = statePattern(state);
  const model = ctx.memory.model;
  const prior = (fp: string) => (f.learning ? model.benefit(pattern, fp).mean : 0.5);
  const effectiveness = f.learning ? model.effectiveness.bind(model) : undefined;
  const horizonSteps = node.horizon?.horizon ?? 1;

  let candidates = [...input.candidates];
  const coverage = [...input.coverage];

  // Proposals the agent made since the last look enter as candidates; the
  // market decides whether any is worth acting on.
  if (f.proposals && node.pendingProposals.length > 0) {
    const proposed = normalizeProposals(node.pendingProposals, state, 'agent', (fp) => (f.learning ? prior(fp) : 0.4));
    node.pendingProposals = [];
    coverage.push({ source: 'proposal:agent', version: '1', invoked: true, proposed: proposed.length, feasible: 0, rejected: 0 });
    candidates.push(...proposed);
  }

  // Advice already given on this run is not re-offered until the premise it
  // was given under has changed: telling the agent the same thing twice buys
  // nothing the first time did not.
  const stale = (c: ActionCandidate) => {
    const at = node.advised.get(candidateFingerprint(c));
    return at !== undefined && at >= node.lastMaterialVersion;
  };
  candidates = candidates.filter((c) => !stale(c));

  // Ruled-out dead ends at this revision are not offered again.
  if (f.learning) {
    const ruled = model.ruledOut(pattern, state.repositoryRevision ?? null);
    if (ruled.size > 0) candidates = candidates.filter((c) => !ruled.has(candidateFingerprint(c)));
  }

  let risk = input.risk;
  let U = 0;
  if (f.discovery && risk) {
    U = actionSpaceUncertainty({
      state, coverage,
      novelty: f.learning ? 1 / (1 + model.seen(pattern)) : 1,
      generationMissRate: f.learning ? model.generationMissRate(pattern) : 0,
    });
    risk = { ...risk, actionSpaceUncertainty: U };
  }
  const valuation = risk
    ? riskValuation(state, risk, { horizon: horizonSteps, effectiveness, optionValue: f.option })
    : undefined;

  const known = new Set(candidates.map(candidateFingerprint));
  let discoveryOffer: ActionCandidate | null = null;
  if (f.discovery && risk) {
    const remainingPool = ctx.pool.entries().filter((e) => !known.has(e.fingerprint) && compatibility(e, state) > 0);
    const tiers: DiscoveryTier[] = [
      ...(remainingPool.length > 0 ? ['registry' as const] : []),
      ...(ctx.semanticExpander ? ['semantic' as const] : []),
      ...(f.proposals && !node.inviteProposals ? ['agent_proposal' as const] : []),
    ];
    const poolPrior = remainingPool.length > 0
      ? remainingPool.reduce((s, e) => s + prior(e.fingerprint), 0) / remainingPool.length : 0.5;
    discoveryOffer = discoveryCandidate({ state, risk, known: candidates, poolPrior, tiers });
  }

  const run = (list: ActionCandidate[]): ActionDecision => {
    const started = now();
    const decision = chooseEconomicAction({
      state, candidates: list, faults: input.faults, valuation, estimates: input.estimates, executable: input.executable,
    });
    node.stats.marketRuns += 1;
    node.stats.marketLatencyMs += Math.max(0, now() - started);
    return decision;
  };

  const first = run(discoveryOffer ? [...candidates, discoveryOffer] : candidates);
  let decision = first;
  let discovery: GovernedDecision['discovery'] = null;
  let expanded: ActionCandidate[] = [];

  if (discoveryOffer && first.action.id === DISCOVERY_ID) {
    const tier = (discoveryOffer.metadata.discovery as { tier: DiscoveryTier }).tier;
    node.stats.discoveries += 1;
    node.stats.discoveryTokens += discoveryOffer.tokenCost + discoveryOffer.orchestrationCost;
    if (tier === 'registry') {
      const exclude = new Set([...known, ...[...node.advised.entries()]
        .filter(([, at]) => at >= node.lastMaterialVersion).map(([fp]) => fp)]);
      expanded = ctx.pool.activate(state, exclude, 3, prior);
      // Motifs for this pattern become cheap composite candidates when both
      // halves are now on the table.
      if (f.learning) {
        const table = new Map([...candidates, ...expanded].map((c) => [candidateFingerprint(c), c]));
        for (const m of ctx.memory.motifs.filter((x) => x.stateSignaturePattern === pattern)) {
          const [a, b] = m.actionSequence.map((fp) => table.get(fp));
          if (a && b) expanded.push({ ...compose(a, b, 'SEQ'), confidence: Math.min(a.confidence, b.confidence, motifPrior(m)) });
        }
      }
    } else if (tier === 'semantic' && ctx.semanticExpander) {
      expanded = ctx.semanticExpander(state, candidates).slice(0, 3);
    } else if (tier === 'agent_proposal') {
      node.inviteProposals = true;
    }
    coverage.push({ source: `discovery:${tier}`, version: '1', invoked: true, proposed: expanded.length, feasible: 0, rejected: 0 });
    discovery = { tier, activated: expanded.map(candidateFingerprint) };
  }

  let final = [...candidates, ...expanded];
  let compositions = 0;
  if (f.composition) {
    const priced = new Map((first.candidates ?? []).map((c) => [c.id, c]));
    const baseline = valuation?.stateValueUsd ?? 0;
    const continueCost = priced.get('continue')?.expectedCostUsd ?? baseline;
    const advantage = (c: ActionCandidate) => {
      const p = priced.get(c.id);
      // Not priced yet (just discovered): optimistic — let the bound decide.
      return p ? continueCost - p.expectedCostUsd : Number.POSITIVE_INFINITY / 2;
    };
    const frontier = Math.max(0, ...final.map(advantage).filter((a) => Number.isFinite(a) && a < 1e300));
    const { composites } = composeCandidates({ primitives: final, state, advantage, frontier });
    compositions = composites.length;
    node.stats.compositionsBuilt += compositions;
    final = [...final, ...composites];
  }

  if (expanded.length > 0 || compositions > 0 || discovery) decision = run(final);

  const prevention: Record<string, PreventionTiming> = {};
  if (risk) {
    for (const c of final.slice(0, 12)) {
      if (c.kind === 'continue' || c.kind === 'stop') continue;
      prevention[c.id] = preventionValue(c, state, risk, horizonSteps, effectiveness).timing;
    }
  }

  return {
    decision,
    packet: null,
    risk,
    horizon: null,
    coverage: settleCoverage(coverage, decision.candidates ?? []),
    discovery,
    candidates: final,
    prevention,
    actionSpaceUncertainty: U,
    compositions,
  };
}

/** Steps 3 and 10: after a decision, price how long to leave the agent alone,
 *  record the packet, and remember what velocity needs next time. */
export function concludeLook(input: {
  state: EconomicState;
  ctx: GovernorContext;
  node: GovernorNodeState;
  governed: GovernedDecision;
  /** Tokens a look cost (the deep path's price when it ran, the screen's when not). */
  lookCostTokens: number;
}): GovernedDecision {
  const { state, ctx, node, governed } = input;
  if (materialTransition(node.premise, state)) node.lastMaterialVersion = state.version;
  for (const part of partsOf(governed.decision.action)) {
    if (typeof part.metadata.advice === 'string') node.advised.set(candidateFingerprint(part), state.version);
  }
  const lookCost = input.lookCostTokens + (ctx.features.learning ? ctx.memory.regretPerLook : 0);
  const horizon = ctx.features.adaptiveHorizon
    ? autonomyHorizon({ state, risk: governed.risk, lookCostTokens: lookCost })
    : null;
  node.horizon = horizon;
  node.premise = premiseOf(state);
  node.prevRisk = governed.risk;
  node.stats.evaluations += 1;
  if (horizon) node.stats.horizons.push(horizon.horizon);
  if (governed.decision.action.kind !== 'continue') node.stats.interventions += 1;

  let packet: DecisionPacket | null = null;
  if (ctx.packets) {
    packet = buildDecisionPacket({
      taskId: ctx.taskId, state, decision: governed.decision, coverage: governed.coverage, risk: governed.risk,
      commitmentDepth: commitmentDepth(state), horizon: horizon?.horizon ?? 1, features: featureNames(ctx.features),
      actionSpaceUncertainty: governed.actionSpaceUncertainty, discovery: governed.discovery, compositions: governed.compositions,
      prevention: governed.prevention,
      memoryRecommended: ctx.features.learning ? ctx.memory.model.recommended(statePattern(state), 3) : [],
      modelFingerprint: ctx.modelFingerprint, harnessFingerprint: ctx.harnessFingerprint, policyVersion: ctx.policyVersion,
    });
    ctx.packets.put(packet);
    node.stats.packetBytes += JSON.stringify(packet).length;
  }
  return { ...governed, packet, horizon };
}

// ---------------------------------------------------------------------------
// Learning (L4)
// ---------------------------------------------------------------------------

/** How many future tasks a lesson is amortized over when pricing diagnosis.
 *  The economic horizon of learning, not a schedule. */
export const LEARNING_HORIZON_TASKS = 100;

export interface LearningResult {
  analysis: MissAnalysis;
  diagnoses: DiagnosisResult[];
  experiencesRecorded: number;
  diagnosticTokens: number;
}

/** Post-outcome accounting: trajectory → outcome → miss diagnosis → optional
 *  replay → causal evidence → calibration. Updates priors for future
 *  decisions; never touches the run it learned from. */
export function learnFromTask(input: {
  trace: TaskTrace;
  memory: GovernorMemory;
  pool?: DormantPool;
  replay?: ReplayExecutor;
  usdPerToken?: number;
  /** Benchmark bucket or other regime label, for calibration groups only. */
  regime?: string;
}): LearningResult {
  const { trace, memory } = input;
  const model = memory.model;
  memory.sequence += 1;
  const seq = memory.sequence;
  const price = input.usdPerToken ?? 3e-6;
  const analysis = analyzeTask(trace, { helpedProbability: (fp) => {
    const last = trace.packets.at(-1);
    return last ? model.benefit(statePattern(last), fp).mean : 0.5;
  } });

  const experiences: CausalExperience[] = [];
  const record = (e: Omit<CausalExperience, 'id' | 'sequence' | 'taskId' | 'repository'>) => experiences.push({
    ...e, id: randomUUID(), sequence: seq, taskId: trace.taskId, repository: null,
  });
  const troubleAfter = (v: number) => trace.events.some((e) => e.version > v
    && (e.kind === 'failure' || (e.kind === 'validation' && e.passed === false)));
  const failed = !trace.outcome.succeeded || trace.outcome.hiddenFailure === true;
  // Only what was actually carried out was an intervention; a decision that was
  // recorded and not acted on is, in effect, carrying on.
  const carriedAt = new Set(trace.events.filter((e) => (e.kind === 'intervention' || e.kind === 'recovery') && e.tokens > 0)
    .map((e) => `${e.version}|${e.fingerprint}`));
  const carried = (p: DecisionPacket) => carriedAt.has(`${p.stateVersion}|${p.chosen.fingerprint}`);

  // Every look is an observation of its state pattern (novelty) and of what
  // was chosen there — weak, post-hoc evidence that lets Level 1 compare an
  // intervention against carrying on.
  for (const p of trace.packets) {
    const pattern = statePattern(p);
    const helped = !failed && !troubleAfter(p.stateVersion);
    const parts = p.chosen.kind === 'continue' || p.chosen.kind === 'stop' || !carried(p) ? [] : [p.chosen.fingerprint];
    record({
      statePattern: pattern, unresolvedUncertainty: [], intervention: '__state__', addresses: [],
      timing: 'post_hoc', observedFailureRisk: p.risk?.immediateFailureProbability ?? 0, lossAvoided: 0,
      interventionCost: 0, preventionEffect: 0, optionEffect: 0, evidenceLevel: 'weak', confidence: 1,
      status: 'FOUND', repositoryRevision: p.repositoryRevision,
    });
    for (const fp of parts.length ? parts : ['continue']) {
      record({
        statePattern: pattern, unresolvedUncertainty: [], intervention: fp,
        addresses: [], timing: (p.governor.prevention[p.chosen.id] ?? 'post_hoc'),
        observedFailureRisk: p.risk?.immediateFailureProbability ?? 0,
        lossAvoided: 0, interventionCost: p.candidates.find((c) => c.status === 'chosen')?.immediateTokens ?? 0,
        preventionEffect: helped ? 1 : -1, optionEffect: 0, evidenceLevel: 'weak', confidence: 0.5,
        status: 'FOUND', repositoryRevision: p.repositoryRevision,
      });
    }
  }

  // Suspected misses: diagnose, as far as it pays.
  const diagnoses: DiagnosisResult[] = [];
  let diagnosticTokens = 0;
  for (const finding of analysis.misses) {
    const boundary = trace.packets.find((p) => p.decisionId === finding.hindsight.boundary?.decisionId);
    const pattern = boundary ? statePattern(boundary) : 'unknown';
    const frequency = (model.seen(pattern) + 1) / (seq + 1);
    const stake = frequency * LEARNING_HORIZON_TASKS * Math.max(0, finding.hindsight.opportunityRegret);
    const prior = model.benefit(pattern, finding.hindsight.fingerprint).n;
    const result = diagnose({
      finding, trace, model, stakeTokens: stake, priorEvidence: prior,
      replayCostTokens: Math.max(1, trace.outcome.totalTokens - (boundary ? 0 : 0)),
      usdPerToken: price, replay: input.replay,
      observed: { succeeded: !failed, tokens: trace.outcome.totalTokens },
    });
    diagnoses.push(result);
    diagnosticTokens += result.costTokens;
    if (!result.evidence || !boundary) continue;
    const ev = result.evidence;
    const candidateSpace = ['POOL_MISS', 'RETRIEVAL_MISS', 'GENERATION_MISS', 'COMPOSITION_MISS'].includes(finding.label);
    record({
      statePattern: pattern,
      unresolvedUncertainty: finding.hindsight.addresses,
      intervention: finding.hindsight.fingerprint,
      addresses: finding.hindsight.addresses,
      timing: boundary.governor.prevention[finding.hindsight.fingerprint] ?? 'post_hoc',
      observedFailureRisk: boundary.risk?.immediateFailureProbability ?? 0,
      lossAvoided: finding.hindsight.opportunityRegret,
      interventionCost: finding.hindsight.costTokens,
      preventionEffect: ev.effectEstimate,
      optionEffect: 0,
      evidenceLevel: ev.evidenceLevel,
      confidence: ev.confidence,
      // A candidate-space miss is also a fact about coverage in this pattern.
      status: ev.effectEstimate > 0 ? 'FOUND' : 'RULED_OUT',
      repositoryRevision: boundary.repositoryRevision,
    });
    if (candidateSpace) {
      record({
        statePattern: pattern, unresolvedUncertainty: [], intervention: `missing:${finding.hindsight.fingerprint}`,
        addresses: [], timing: 'post_hoc', observedFailureRisk: 0, lossAvoided: 0, interventionCost: 0,
        preventionEffect: 0, optionEffect: 0, evidenceLevel: ev.evidenceLevel, confidence: ev.confidence,
        status: 'NOT_FOUND', repositoryRevision: boundary.repositoryRevision,
      });
    }
    // A proposal that proved useful joins the dormant pool, so it no longer
    // needs the agent to think of it again.
    if (input.pool && ev.effectEstimate > 0 && ev.evidenceLevel !== 'weak' && finding.hindsight.fingerprint.startsWith('proposal:')) {
      const entry: DormantCandidate = {
        fingerprint: finding.hindsight.fingerprint, kind: 'acquire_evidence', capability: finding.hindsight.capability,
        advice: 'A previously useful intervention for this kind of state.', addresses: finding.hindsight.addresses,
        effect: 0.5, costShare: 0.03, origin: 'proposal',
      };
      input.pool.add(entry);
    }
  }
  for (const e of experiences) memory.experiences.put(e);

  // Motifs: pairs of interventions on a run, in order, and whether trouble
  // followed.
  const taken = trace.packets.filter((p) => p.chosen.kind !== 'continue' && p.chosen.kind !== 'stop' && carried(p));
  const motifObs: MotifObservation[] = [];
  for (let i = 0; i + 1 < taken.length; i++) {
    const a = taken[i]; const b = taken[i + 1];
    if (a.chosen.fingerprint === b.chosen.fingerprint) continue;
    const helped = !failed && !troubleAfter(b.stateVersion);
    motifObs.push({
      pattern: statePattern(a), sequence: [a.chosen.fingerprint, b.chosen.fingerprint], helped,
      lossAvoided: helped ? Math.max(0, analysis.realizedLoss) || trace.outcome.reworkTokens + 1 : 0,
      cost: (a.candidates.find((c) => c.status === 'chosen')?.immediateTokens ?? 0) + (b.candidates.find((c) => c.status === 'chosen')?.immediateTokens ?? 0),
      confidence: 0.5, taskSequence: seq,
    });
  }
  memory.motifs = updateMotifs(memory.motifs, motifObs, seq);

  // Calibration of the governor's own probabilities.
  const observations: CalibrationObservation[] = [];
  for (const p of trace.packets) {
    if (!p.risk) continue;
    const trouble = troubleAfter(p.stateVersion) || failed ? 1 : 0;
    observations.push({
      target: 'failure', predicted: p.risk.immediateFailureProbability, observed: trouble,
      group: { regime: input.regime ?? '-', provenance: p.candidates.find((c) => c.status === 'chosen')?.provenance ?? '-', capability: p.chosen.capability },
    });
    const chosen = p.candidates.find((c) => c.status === 'chosen');
    if (chosen) observations.push({
      target: 'success', predicted: chosen.successLowerBound, observed: failed ? 0 : 1,
      group: { regime: input.regime ?? '-', provenance: chosen.provenance, capability: chosen.capability },
    });
    if (p.governor.discovery) observations.push({
      target: 'discovery', predicted: p.governor.actionSpaceUncertainty,
      observed: p.governor.discovery.activated.includes(p.chosen.fingerprint) ? 1 : 0,
      group: { regime: input.regime ?? '-', provenance: 'governor', capability: 'governor.discover' },
    });
  }
  memory.calibration = [...memory.calibration, ...observations].slice(-20_000);
  // What a look risked on this task, folded into a running average over tasks
  // (equal weight per task) so the horizon learns when looking is not worth it.
  if (trace.packets.length > 0) {
    const perLook = analysis.interventionRegret / trace.packets.length;
    memory.regretPerLook += (perLook - memory.regretPerLook) / Math.min(seq, 50);
  }
  refreshModel(memory);

  return { analysis, diagnoses, experiencesRecorded: experiences.length, diagnosticTokens };
}

/** What a decision asks the agent to do, as advice it may ignore. Only
 *  governor-originated interventions (dormant, proposed, composed) carry
 *  advice; everything else keeps the carry-out the runtime already had. */
export function adviceFor(decision: ActionDecision): string {
  const parts = partsOf(decision.action);
  const lines = parts.map((p) => (typeof p.metadata.advice === 'string' ? p.metadata.advice : '')).filter(Boolean);
  return lines.length === 0 ? '' : `Advisory from the runtime (you decide whether it applies):\n- ${lines.join('\n- ')}`;
}

export { usdPerToken };
