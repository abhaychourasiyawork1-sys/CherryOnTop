/** How much to pay to find out whether a suspected miss was real.
 *
 *  Diagnosis is itself a spend, so it is governed like any other: the options
 *  are candidates, and the same market that chooses interventions chooses
 *  among them, on a small state whose "remaining work" is the future loss the
 *  diagnosis could prevent. Most suspected misses end at Level 0 or 1, which
 *  cost nothing but arithmetic; a replay is bought only when what it could
 *  teach is worth more than re-running the agent.
 *
 *   - **Level 0, deterministic** — was the alternative feasible, at a
 *     compatible state and revision, linked to the recovery that actually
 *     worked, and did its evidence exist in time? Weak evidence at best.
 *   - **Level 1, empirical** — P(success | pattern, alternative) against
 *     P(success | pattern, what was chosen), from causal memory, with an
 *     interval. Supported when the interval excludes zero.
 *   - **Level 2, replay** — the run re-executed from the boundary with the
 *     alternative, by an injected executor on a *frozen copy* of the packet.
 *     Validated only when at least two replays agree; one replay is supported.
 *
 *  An LLM is never asked whether the alternative would have worked. */
import { clamp01 } from '../efficiency/policy-types.js';
import { actionCandidate } from '../decision/actions.js';
import { initialEconomicState, normalizeEconomicState } from '../decision/state.js';
import { chooseEconomicAction } from '../decision/engine.js';
import type { DecisionPacket } from './packet.js';
import type { HindsightCandidate, MissFinding, TaskTrace } from './miss.js';
import { statePattern, EVIDENCE_WEIGHT, type CausalModel, type EvidenceLevel } from './memory.js';

export type DiagnosisOption =
  | 'NO_DIAGNOSIS' | 'CHEAP_DIAGNOSIS' | 'EMPIRICAL_ESTIMATE' | 'REPLAY_ONE' | 'REPLAY_MULTIPLE' | 'DISCARD_AS_NON_MISS';

export interface OutcomeSummary { succeeded: boolean; tokens: number }

export interface CounterfactualEvidence {
  intervention: string;
  observedOutcome: OutcomeSummary;
  alternativeOutcome: OutcomeSummary;
  /** Signed change in P(success) the alternative is estimated to make. */
  effectEstimate: number;
  replayCount: number;
  /** Share of replays agreeing with the effect's sign. 1 with none. */
  consistency: number;
  confounders: string[];
  confidence: number;
  replayCostTokens: number;
  replayCostUsd: number;
  evidenceLevel: EvidenceLevel;
}

/** Re-runs the task from a boundary with one intervention applied. Must not
 *  touch production state: it receives a structured clone of the packet and
 *  nothing it returns is written anywhere but the evidence record. */
export type ReplayExecutor = (request: {
  packet: Readonly<DecisionPacket>;
  intervention: Readonly<HindsightCandidate>;
  replays: number;
}) => OutcomeSummary[];

export interface DiagnosisResult {
  option: DiagnosisOption;
  evidence: CounterfactualEvidence | null;
  /** Tokens the diagnosis itself spent (replays). */
  costTokens: number;
  /** What the deterministic checks found, whatever was chosen after. */
  levelZero: { passed: number; checks: number; reasons: string[] };
}

/** Replays bought by REPLAY_MULTIPLE: enough for two to be able to agree with
 *  a third breaking a tie. */
export const MULTIPLE_REPLAYS = 3;

function levelZero(finding: MissFinding, packet: DecisionPacket | undefined, trace: TaskTrace): DiagnosisResult['levelZero'] {
  const h = finding.hindsight;
  const checks: Array<[string, boolean]> = [
    ['feasible_alternative', h.feasibleAtBoundary],
    ['compatible_revision', !!packet && packet.repositoryRevision === (trace.packets.at(-1)?.repositoryRevision ?? null)],
    ['recovery_linkage', h.discoverySource === 'recovery' || h.discoverySource === 'validation' || h.discoverySource === 'later_action'],
    ['failure_signature_matched', trace.events.some((e) => e.kind === 'failure' && !!e.signature)
      || trace.events.some((e) => e.kind === 'validation' && e.passed === false)],
    ['positive_regret', h.opportunityRegret > 0],
  ];
  return {
    passed: checks.filter(([, ok]) => ok).length,
    checks: checks.length,
    reasons: checks.filter(([, ok]) => !ok).map(([name]) => `failed:${name}`),
  };
}

function levelOne(h: HindsightCandidate, packet: DecisionPacket, model: CausalModel): { effect: number; lower: number; n: number } {
  const pattern = statePattern(packet);
  const alt = model.benefit(pattern, h.fingerprint);
  const chosen = model.benefit(pattern, packet.chosen.fingerprint);
  const effect = alt.mean - chosen.mean;
  const n = Math.min(alt.n, chosen.n > 0 ? chosen.n : alt.n);
  const se = Math.sqrt((alt.mean * (1 - alt.mean)) / Math.max(1, alt.n) + (chosen.mean * (1 - chosen.mean)) / Math.max(1, chosen.n));
  return { effect, lower: effect - 1.96 * se, n };
}

/** Diagnoses one suspected miss.
 *
 *  `stakeTokens` is the future loss at stake if this pattern repeats and the
 *  lesson is not learned: how often the pattern recurs times what this miss
 *  cost. `priorEvidence` is how many pseudo-observations memory already holds
 *  about it — a lesson already learned is not worth paying to learn again. */
export function diagnose(input: {
  finding: MissFinding;
  trace: TaskTrace;
  model: CausalModel;
  stakeTokens: number;
  priorEvidence: number;
  /** Tokens one replay would cost: the run from the boundary onwards. */
  replayCostTokens: number;
  usdPerToken: number;
  replay?: ReplayExecutor;
  observed: OutcomeSummary;
}): DiagnosisResult {
  const { finding, trace, model } = input;
  const packet = trace.packets.find((p) => p.decisionId === finding.hindsight.boundary?.decisionId);
  const zero = levelZero(finding, packet, trace);
  const nonMiss = !finding.hindsight.feasibleAtBoundary || finding.hindsight.opportunityRegret <= 0;

  // How much one more piece of evidence at each level would move the belief:
  // its weight against what is already known.
  const move = (level: EvidenceLevel, count = 1) => {
    const w = EVIDENCE_WEIGHT[level] * count;
    return w / (w + Math.max(0, input.priorEvidence) + 1);
  };
  const stake = Math.max(0, input.stakeTokens);
  const replayAvailable = !!input.replay && !!packet;
  const empirical = packet ? levelOne(finding.hindsight, packet, model) : { effect: 0, lower: 0, n: 0 };

  // The menu, priced as the market prices anything: what it would save
  // (loss at stake times how far it moves the belief) against what it costs.
  const options = [
    actionCandidate({ id: 'CHEAP_DIAGNOSIS', kind: 'acquire_evidence', capability: 'diagnosis.level0',
      expectedTokenBenefit: stake * move('weak') * (zero.passed / zero.checks), tokenCost: 1, confidence: 1 }),
    ...(empirical.n > 0 ? [actionCandidate({ id: 'EMPIRICAL_ESTIMATE', kind: 'acquire_evidence', capability: 'diagnosis.level1',
      expectedTokenBenefit: stake * move('supported') * clamp01(empirical.n / (empirical.n + 4)), tokenCost: 5, confidence: 1 })] : []),
    ...(replayAvailable ? [
      actionCandidate({ id: 'REPLAY_ONE', kind: 'acquire_evidence', capability: 'diagnosis.replay',
        expectedTokenBenefit: stake * move('supported'), tokenCost: input.replayCostTokens, confidence: 1 }),
      actionCandidate({ id: 'REPLAY_MULTIPLE', kind: 'acquire_evidence', capability: 'diagnosis.replay',
        expectedTokenBenefit: stake * move('validated', MULTIPLE_REPLAYS), tokenCost: input.replayCostTokens * MULTIPLE_REPLAYS, confidence: 1 }),
    ] : []),
    ...(nonMiss ? [actionCandidate({ id: 'DISCARD_AS_NON_MISS', kind: 'constrain', capability: 'diagnosis.discard',
      // Discarding keeps a false lesson out of memory: worth what a weak
      // false signal would otherwise have moved.
      expectedTokenBenefit: stake * move('weak'), tokenCost: 0, confidence: 1 })] : []),
  ];
  const budget = Math.max(1, stake + input.replayCostTokens * MULTIPLE_REPLAYS);
  const state = normalizeEconomicState({
    ...initialEconomicState({ goal: `diagnose:${finding.hindsight.fingerprint}`, totalTokenBudget: budget, validationRequired: false }),
    trajectory: { progress: 0, informationGain: 0, explorationPressure: 0, failurePressure: 0, stateSimilarity: 0, orchestrationConfidence: 1 },
    uncertainty: { target: 0, structural: 0, behavioral: 0, validation: 0 },
    resources: {
      totalTokenBudget: budget, consumedTokens: 0, remainingTokens: budget, optimizationTokens: budget,
      optimizationConsumedTokens: 0, recoveryReserve: 0, expectedTaskTokens: Math.max(1, stake), usdPerToken: input.usdPerToken,
    },
    // Diagnosis has no quality floor of its own: nothing it chooses can make
    // a task's result wrong.
    constraints: { qualityFloor: 0, hardStop: false },
  });
  const decision = chooseEconomicAction({ state, candidates: options, decisionId: `diag-${finding.hindsight.fingerprint}` });
  const option: DiagnosisOption = decision.action.kind === 'continue' ? 'NO_DIAGNOSIS' : (decision.action.id as DiagnosisOption);

  const base = (level: EvidenceLevel, effect: number, confidence: number, extra: Partial<CounterfactualEvidence> = {}): CounterfactualEvidence => ({
    intervention: finding.hindsight.fingerprint,
    observedOutcome: input.observed,
    alternativeOutcome: { succeeded: effect > 0 || input.observed.succeeded, tokens: Math.max(0, input.observed.tokens - finding.hindsight.opportunityRegret) },
    effectEstimate: effect,
    replayCount: 0,
    consistency: 1,
    confounders: ['post_hoc_association'],
    confidence: clamp01(confidence),
    replayCostTokens: 0,
    replayCostUsd: 0,
    evidenceLevel: level,
    ...extra,
  });

  if (option === 'NO_DIAGNOSIS' || option === 'DISCARD_AS_NON_MISS') return { option, evidence: null, costTokens: 0, levelZero: zero };
  if (option === 'CHEAP_DIAGNOSIS') {
    return { option, evidence: base('weak', finding.hindsight.laterUsefulness * (zero.passed / zero.checks), zero.passed / zero.checks), costTokens: 0, levelZero: zero };
  }
  if (option === 'EMPIRICAL_ESTIMATE') {
    const level: EvidenceLevel = empirical.lower > 0 ? 'supported' : 'weak';
    return {
      option,
      evidence: base(level, empirical.effect, clamp01(empirical.n / (empirical.n + 4)), { confounders: ['selection_in_history', 'pattern_coarseness'] }),
      costTokens: 0, levelZero: zero,
    };
  }

  // Replay. The executor gets a frozen copy; the original is never reachable.
  const replays = option === 'REPLAY_MULTIPLE' ? MULTIPLE_REPLAYS : 1;
  const frozen = Object.freeze(structuredClone(packet!));
  const outcomes = input.replay!({ packet: frozen, intervention: Object.freeze({ ...finding.hindsight }), replays });
  if (outcomes.length === 0) return { option, evidence: null, costTokens: 0, levelZero: zero };
  const rate = outcomes.filter((o) => o.succeeded).length / outcomes.length;
  const effect = rate - (input.observed.succeeded ? 1 : 0);
  const tokens = outcomes.reduce((s, o) => s + o.tokens, 0);
  const sign = Math.sign(effect) || Math.sign(input.observed.tokens - tokens / outcomes.length);
  const agreeing = outcomes.filter((o) => Math.sign((o.succeeded ? 1 : 0) - (input.observed.succeeded ? 1 : 0)
    || (input.observed.tokens - o.tokens)) === sign).length;
  const consistency = agreeing / outcomes.length;
  const level: EvidenceLevel = outcomes.length >= 2 && consistency === 1 ? 'validated' : 'supported';
  return {
    option,
    evidence: base(level, effect !== 0 ? effect : sign * clamp01((input.observed.tokens - tokens / outcomes.length) / Math.max(1, input.observed.tokens)), consistency, {
      alternativeOutcome: { succeeded: rate >= 0.5, tokens: tokens / outcomes.length },
      replayCount: outcomes.length,
      consistency,
      confounders: outcomes.length < 2 ? ['single_replay', 'model_nondeterminism'] : ['model_nondeterminism'],
      replayCostTokens: tokens,
      replayCostUsd: tokens * input.usdPerToken,
    }),
    costTokens: tokens,
    levelZero: zero,
  };
}
