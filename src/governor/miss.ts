/** What actually went wrong — and whether anything the governor could have
 *  done would have helped.
 *
 *  A failure is not a miss. A task can fail because it was impossible, because
 *  execution was noisy, because a good decision met a bad outcome, or because
 *  the governor genuinely missed a feasible, worthwhile intervention — and only
 *  the last should teach the governor anything about intervening. So the order
 *  here is: find where the trouble surfaced; find what fixed it (or what could
 *  have); find the earlier boundaries at which that was *feasible*; pick the
 *  boundary where it would have paid most (not the earliest); and only then ask
 *  the packet at that boundary *why* it was not taken — never generated,
 *  rejected, pruned, estimated wrong, ranked wrong, or taken too late.
 *
 *  This is a trajectory backtrace over compact records, not an explanation
 *  written by a model. */
import { clamp01 } from '../efficiency/policy-types.js';
import type { UncertaintyKind } from '../decision/state.js';
import { UNCERTAINTY_KINDS } from '../decision/uncertainty.js';
import { stateFromPacket, type DecisionPacket } from './packet.js';
import { activateDormant, compatibility, type DormantCandidate } from './coverage.js';
import { contractOf, unmetPreconditions } from './contracts.js';
import type { ActionMotif } from './memory.js';

export type CandidateSpaceMiss = 'POOL_MISS' | 'RETRIEVAL_MISS' | 'GENERATION_MISS' | 'COMPOSITION_MISS';
export type DecisionMiss = 'ESTIMATION_MISS' | 'RANKING_MISS' | 'PRUNING_MISS' | 'PRECOMMITMENT_MISS';
export type ControlMiss = 'MEMORY_MISS' | 'REPRESENTATION_MISS' | 'VALIDATION_MISS' | 'EXECUTION_MISS';
export type MissLabel = CandidateSpaceMiss | DecisionMiss | ControlMiss;

export type OutcomeClass =
  | 'CLEAN_SUCCESS' | 'SUCCESS_AFTER_RECOVERY' | 'SUCCESS_AFTER_VALIDATION_CATCH' | 'NEAR_MISS'
  | 'FAILURE_UNAVOIDABLE' | 'FAILURE_WITHOUT_FEASIBLE_MITIGATION' | 'MISSED_OPPORTUNITY' | 'UNKNOWN';

/** Production-visible things that happened on the run, in state-version
 *  order. Nothing here is a benchmark label. */
export interface TraceEvent {
  version: number;
  kind: 'failure' | 'validation' | 'intervention' | 'recovery';
  signature?: string;
  passed?: boolean;
  fingerprint?: string;
  capability?: string;
  addresses?: UncertaintyKind[];
  tokens: number;
}

export interface TaskOutcome {
  /** The runtime's own verdict: validated success. */
  succeeded: boolean;
  /** Ground truth disagreed with a validated success. Only a benchmark or a
   *  later independent check can know this. */
  hiddenFailure?: boolean;
  totalTokens: number;
  /** Tokens spent between the first sign of trouble and recovery. */
  reworkTokens: number;
  capabilityMissing?: boolean;
}

export interface TaskTrace {
  taskId: string;
  packets: DecisionPacket[];
  events: TraceEvent[];
  outcome: TaskOutcome;
  pool: readonly DormantCandidate[];
  motifs?: readonly ActionMotif[];
  /** Capabilities registered sources have ever produced on this run: what
   *  *could* have been generated. */
  sourceCapabilities?: string[];
}

export type HindsightSource = 'recovery' | 'validation' | 'later_action' | 'motif' | 'replay' | 'pool';

export interface HindsightCandidate {
  fingerprint: string;
  capability: string;
  addresses: UncertaintyKind[];
  discoverySource: HindsightSource;
  /** The economically best boundary to have taken it at, when one was feasible. */
  boundary: { decisionId: string; stateVersion: number } | null;
  feasibleAtBoundary: boolean;
  feasibilityReasons: string[];
  /** Evidence it helped later, on [0,1]. */
  laterUsefulness: number;
  /** Tokens it would have saved at the boundary, net of its cost. */
  opportunityRegret: number;
  costTokens: number;
}

export interface MissFinding {
  label: MissLabel;
  hindsight: HindsightCandidate;
  /** Deterministic (Level-0) confidence; the ladder may strengthen it. */
  confidence: number;
}

export interface MissAnalysis {
  taskId: string;
  outcomeClass: OutcomeClass;
  detectionVersion: number | null;
  /** Tokens of downstream loss the trouble cost. */
  realizedLoss: number;
  hindsight: HindsightCandidate[];
  misses: MissFinding[];
  nearMiss: boolean;
  /** Avoidable downstream cost accumulated before mitigation. */
  preventionDebt: number;
  /** Interventions that cost something and, as far as can be told, bought
   *  nothing: their cost plus the disruption to the agent. */
  interventionRegret: number;
  unnecessaryInterventions: number;
}

/** What an intervention disrupts beyond its own tokens: the agent re-reading
 *  what it was told and re-orienting. A share of the intervention's own cost,
 *  as the honest minimum; measured disruption replaces it in a benchmark. */
export const DISRUPTION_SHARE = 0.5;

function firstTrouble(events: TraceEvent[]): TraceEvent | null {
  return events.find((e) => e.kind === 'failure' || (e.kind === 'validation' && e.passed === false)) ?? null;
}

function remediesAfter(events: TraceEvent[], version: number): TraceEvent[] {
  return events.filter((e) => e.version >= version && (e.kind === 'recovery' || e.kind === 'intervention'
    || (e.kind === 'validation' && e.passed === true)) && e.fingerprint);
}

/** The doubt dimensions most implicated at a boundary: where the exposure was. */
function implicated(packet: DecisionPacket | undefined): UncertaintyKind[] {
  if (!packet) return ['validation'];
  const source = packet.risk?.exposureByDimension;
  const score = (k: UncertaintyKind) => (source ? source[k] : packet.uncertainty[k]);
  const best = Math.max(...UNCERTAINTY_KINDS.map(score));
  return best <= 0 ? ['validation'] : UNCERTAINTY_KINDS.filter((k) => score(k) >= best * 0.999);
}

/** Share of a boundary's failure exposure an action addressing `dims` could
 *  touch, by noisy-OR — the same rule the risk model prices with. */
function addressableShare(packet: DecisionPacket, dims: UncertaintyKind[]): number {
  if (dims.length === 0) return 0;
  const exposure = packet.risk?.exposureByDimension;
  const total = packet.risk?.riskExposure ?? 0;
  let kept = 1;
  for (const k of dims) {
    const share = exposure && total > 0 ? clamp01(exposure[k] / total)
      : clamp01(packet.uncertainty[k] / Math.max(1e-9, UNCERTAINTY_KINDS.reduce((s, d) => s + packet.uncertainty[d], 0)));
    kept *= 1 - share;
  }
  return clamp01(1 - kept);
}

interface Seed { fingerprint: string; capability: string; addresses: UncertaintyKind[]; source: HindsightSource; usefulness: number }

function seeds(trace: TaskTrace, detection: TraceEvent | null): Seed[] {
  const out = new Map<string, Seed>();
  const add = (s: Seed) => { const cur = out.get(s.fingerprint); if (!cur || cur.usefulness < s.usefulness) out.set(s.fingerprint, s); };
  if (detection) {
    for (const r of remediesAfter(trace.events, detection.version)) {
      add({
        fingerprint: r.fingerprint!, capability: r.capability ?? r.fingerprint!, addresses: r.addresses ?? [],
        source: r.kind === 'validation' ? 'validation' : r.kind === 'recovery' ? 'recovery' : 'later_action',
        // A remedy that came before a validated success demonstrably helped.
        usefulness: trace.outcome.succeeded ? 1 : 0.5,
      });
    }
  }
  // What could have addressed the implicated doubt, from the pool and from
  // motifs, when nothing on the run itself shows the remedy.
  const before = trace.packets.filter((p) => !detection || p.stateVersion < detection.version).at(-1);
  const dims = detection?.kind === 'validation' ? ['validation' as UncertaintyKind] : implicated(before);
  for (const entry of trace.pool) {
    if (entry.addresses.some((a) => dims.includes(a))) {
      add({ fingerprint: entry.fingerprint, capability: entry.capability, addresses: entry.addresses, source: 'pool', usefulness: 0.5 * entry.effect });
    }
  }
  for (const motif of trace.motifs ?? []) {
    const fp = `SEQ(${motif.actionSequence[0]},${motif.actionSequence[1]})`;
    add({ fingerprint: fp, capability: 'composite.seq', addresses: [], source: 'motif', usefulness: motif.successRate * 0.5 });
  }
  return [...out.values()];
}

/** Cost of an action at a boundary: what the packet priced it at when it was
 *  on the table, the pool's share of the remaining budget otherwise. */
function costAt(packet: DecisionPacket, seed: Seed, pool: readonly DormantCandidate[]): number | null {
  const seen = packet.candidates.find((c) => c.fingerprint === seed.fingerprint || c.id === seed.fingerprint);
  if (seen) return seen.immediateTokens;
  const entry = pool.find((e) => e.fingerprint === seed.fingerprint);
  if (entry) return Math.round(packet.resources.remainingTokens * entry.costShare);
  return null;
}

function feasibility(packet: DecisionPacket, seed: Seed, trace: TaskTrace): { ok: boolean; reasons: string[]; cost: number } {
  const reasons: string[] = [];
  const cost = costAt(packet, seed, trace.pool);
  const seen = packet.candidates.find((c) => c.fingerprint === seed.fingerprint || c.id === seed.fingerprint);
  const entry = trace.pool.find((e) => e.fingerprint === seed.fingerprint);
  const capabilityExisted = !!seen || !!entry || (trace.sourceCapabilities ?? []).includes(seed.capability)
    || seed.source === 'recovery' || seed.source === 'later_action' || seed.source === 'validation';
  if (!capabilityExisted) reasons.push('capability_absent');
  if (cost === null) reasons.push('cost_unknown');
  else if (cost > packet.resources.remainingTokens) reasons.push('budget');
  if (seen?.status === 'rejected' && seen.reasonCodes.some((c) => c.startsWith('insufficient_budget') || c === 'optimization_budget_exhausted' || c.startsWith('fault:'))) {
    reasons.push(`blocked:${seen.reasonCodes.find((c) => c.startsWith('insufficient') || c.startsWith('fault:') || c === 'optimization_budget_exhausted')}`);
  }
  if (entry) {
    const state = stateFromPacket(packet);
    if (unmetPreconditions(contractOf(activateDormant(entry, state)), state).length > 0) reasons.push('preconditions');
  }
  return { ok: reasons.length === 0, reasons, cost: cost ?? 0 };
}

/** Why the best hindsight candidate was not taken, read off the packet at
 *  its boundary. */
export function classify(
  hindsight: HindsightCandidate, packet: DecisionPacket | undefined, trace: TaskTrace,
): MissLabel | null {
  if (!packet || !hindsight.feasibleAtBoundary || hindsight.opportunityRegret <= 0) return null;
  const takenLater = trace.packets.some((p) => p.stateVersion > packet.stateVersion
    && (p.chosen.fingerprint === hindsight.fingerprint || p.chosen.id === hindsight.fingerprint));
  const seen = packet.candidates.find((c) => c.fingerprint === hindsight.fingerprint || c.id === hindsight.fingerprint);
  if (seen?.status === 'chosen') return 'EXECUTION_MISS';
  if (takenLater && seen) return 'PRECOMMITMENT_MISS';
  if (packet.governor.memoryRecommended.includes(hindsight.fingerprint) && !seen) return 'MEMORY_MISS';
  if (seen) {
    if (seen.status === 'pruned') return 'PRUNING_MISS';
    if (seen.status === 'rejected') return 'ESTIMATION_MISS';
    const chosen = packet.candidates.find((c) => c.status === 'chosen');
    if (!chosen) return 'RANKING_MISS';
    // Predicted cheaper in expectation but lost on the bound: the doubt band,
    // not the estimate, cost it the decision.
    return seen.expectedCostUsd < chosen.expectedCostUsd ? 'RANKING_MISS' : 'ESTIMATION_MISS';
  }
  if (takenLater) return 'PRECOMMITMENT_MISS';
  // Never on the table at that boundary.
  if (packet.risk && packet.risk.riskExposure <= 0) return 'REPRESENTATION_MISS';
  if (hindsight.fingerprint.startsWith('SEQ(') || hindsight.fingerprint.startsWith('PAR(')) return 'COMPOSITION_MISS';
  const inPool = trace.pool.find((e) => e.fingerprint === hindsight.fingerprint);
  if (inPool) return compatibility(inPool, stateFromPacket(packet)) > 0 ? 'RETRIEVAL_MISS' : 'POOL_MISS';
  if ((trace.sourceCapabilities ?? []).includes(hindsight.capability)) return 'GENERATION_MISS';
  return 'POOL_MISS';
}

export function analyzeTask(
  trace: TaskTrace,
  options: {
    /** P(an intervention helped | its fingerprint), from causal memory, for
     *  the regret of interventions whose effect cannot be observed directly. */
    helpedProbability?: (fingerprint: string) => number;
  } = {},
): MissAnalysis {
  const detection = firstTrouble(trace.events);
  const { outcome } = trace;
  const failed = !outcome.succeeded || outcome.hiddenFailure === true;
  const realizedLoss = failed ? outcome.totalTokens : outcome.reworkTokens;

  // Boundaries at which prevention was still possible: before the trouble
  // surfaced, or — when it never surfaced — the whole run.
  const boundaries = trace.packets.filter((p) => !detection || p.stateVersion < detection.version);

  const hindsight: HindsightCandidate[] = seeds(trace, detection).map((seed) => {
    let best: HindsightCandidate | null = null;
    let fallbackReasons: string[] = boundaries.length === 0 ? ['no_boundary'] : [];
    for (const packet of boundaries) {
      const f = feasibility(packet, seed, trace);
      if (!f.ok) { fallbackReasons = f.reasons; continue; }
      const share = seed.addresses.length > 0 ? addressableShare(packet, seed.addresses) : seed.usefulness;
      const regret = realizedLoss * seed.usefulness * share - f.cost;
      if (!best || regret > best.opportunityRegret) {
        best = {
          fingerprint: seed.fingerprint, capability: seed.capability, addresses: seed.addresses,
          discoverySource: seed.source, boundary: { decisionId: packet.decisionId, stateVersion: packet.stateVersion },
          feasibleAtBoundary: true, feasibilityReasons: [], laterUsefulness: seed.usefulness,
          opportunityRegret: regret, costTokens: f.cost,
        };
      }
    }
    return best ?? {
      fingerprint: seed.fingerprint, capability: seed.capability, addresses: seed.addresses,
      discoverySource: seed.source, boundary: null, feasibleAtBoundary: false, feasibilityReasons: fallbackReasons,
      laterUsefulness: seed.usefulness, opportunityRegret: 0, costTokens: 0,
    };
  }).sort((a, b) => b.opportunityRegret - a.opportunityRegret || (a.fingerprint < b.fingerprint ? -1 : 1));

  const top = hindsight.find((h) => h.feasibleAtBoundary && h.opportunityRegret > 0) ?? null;
  const misses: MissFinding[] = [];
  // Validation passed and the work was wrong: a fact about validation,
  // whatever else could have been done, so it is labelled whether or not a
  // profitable alternative existed.
  if (outcome.succeeded && outcome.hiddenFailure) {
    const subject = top ?? hindsight.find((h) => h.addresses.includes('validation')) ?? hindsight[0] ?? {
      fingerprint: 'validation', capability: 'validation', addresses: ['validation'] as UncertaintyKind[],
      discoverySource: 'validation' as const, boundary: null, feasibleAtBoundary: false, feasibilityReasons: ['no_boundary'],
      laterUsefulness: 0, opportunityRegret: 0, costTokens: 0,
    };
    misses.push({ label: 'VALIDATION_MISS', hindsight: subject, confidence: 0.5 });
  }
  if (top && realizedLoss > 0) {
    const packet = trace.packets.find((p) => p.decisionId === top.boundary?.decisionId);
    const label = classify(top, packet, trace);
    if (label) misses.push({ label, hindsight: top, confidence: clamp01(top.laterUsefulness) });
  }

  const preventable = !!top && realizedLoss > 0;
  let outcomeClass: OutcomeClass;
  if (trace.packets.length === 0 && trace.events.length === 0) outcomeClass = 'UNKNOWN';
  else if (!failed) {
    if (!detection) outcomeClass = 'CLEAN_SUCCESS';
    else if (preventable) outcomeClass = 'NEAR_MISS';
    else outcomeClass = detection.kind === 'validation' ? 'SUCCESS_AFTER_VALIDATION_CATCH' : 'SUCCESS_AFTER_RECOVERY';
  } else if (outcome.capabilityMissing || hindsight.length === 0) outcomeClass = 'FAILURE_UNAVOIDABLE';
  else if (!preventable) outcomeClass = hindsight.some((h) => h.feasibleAtBoundary) ? 'FAILURE_UNAVOIDABLE' : 'FAILURE_WITHOUT_FEASIBLE_MITIGATION';
  else outcomeClass = 'MISSED_OPPORTUNITY';

  // Interventions that, as far as anyone can tell, bought nothing. Only those
  // actually carried out (trace events) cost anything; a decision recorded and
  // not acted on spent nothing and disrupted no one.
  const helped = options.helpedProbability ?? (() => 0.5);
  let interventionRegret = 0;
  let unnecessary = 0;
  for (const e of trace.events) {
    if ((e.kind !== 'intervention' && e.kind !== 'recovery') || !e.fingerprint || e.tokens <= 0) continue;
    const troubleAfter = trace.events.some((x) => x.version > e.version
      && (x.kind === 'failure' || (x.kind === 'validation' && x.passed === false)));
    // Trouble surfaced anyway, or nothing went wrong and nothing says it
    // prevented anything: its cost is regret in proportion to how unlikely it
    // is to have helped.
    const pHelped = troubleAfter ? 0 : clamp01(helped(e.fingerprint));
    interventionRegret += (1 - pHelped) * e.tokens * (1 + DISRUPTION_SHARE);
    if (pHelped < 0.5) unnecessary += 1;
  }

  return {
    taskId: trace.taskId,
    outcomeClass,
    detectionVersion: detection?.version ?? null,
    realizedLoss,
    hindsight,
    misses,
    nearMiss: outcomeClass === 'NEAR_MISS',
    preventionDebt: preventable ? Math.max(0, top!.opportunityRegret) : 0,
    interventionRegret,
    unnecessaryInterventions: unnecessary,
  };
}
