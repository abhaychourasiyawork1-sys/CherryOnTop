/** Pricing future loss, and *when* preventing it pays.
 *
 *  The market already ranks on Q(s,a) = C_now + E[V(s')], and V(s) already
 *  charges a redo probability times what a redo costs. What it does not know is
 *  *direction*: a run whose redo probability is 0.3 and rising is not the same
 *  state as one at 0.3 and falling, and an intervention that would prevent a
 *  loss is worth different amounts before and after the work commits to a
 *  course. This module adds exactly that, through the one seam the market
 *  offers for it — the signal level of the estimate funnel — and nowhere else.
 *
 *  Anti-double-counting, stated once and kept by construction:
 *
 *   - **One loss channel.** Expected downstream loss is p_h × R: the
 *     short-horizon failure probability times what recovering costs. V_r(s) is
 *     `remaining + p_h·R`, which *is* V(s) when risk is not moving (p_h = redo).
 *   - **One claim per channel.** A candidate can lower p_h two ways: by its
 *     contract (which doubts it removes, priced against how much of the loss
 *     those doubts carry) or by its own claimed quality benefit. The larger is
 *     used — never the sum.
 *   - **Information is credited only where it lands.** Exposure is attributed
 *     to doubt dimensions; a structural read reduces only the structural share.
 *   - **Option value modulates information, it is not a cost term.** It
 *     multiplies the risk reduction of information-only actions taken before
 *     the work commits (VOI × (1 + λ·OE)), and is never added to Q itself.
 *
 *  Deterministic, total, no I/O. */
import { clamp01 } from '../efficiency/policy-types.js';
import { normalizeActionCandidate, type ActionCandidate } from '../decision/actions.js';
import type { EconomicState, UncertaintyKind } from '../decision/state.js';
import type { ActionTransitionEstimate } from '../decision/transition.js';
import { UNCERTAINTY_KINDS } from '../decision/uncertainty.js';
import {
  redoProbability, wrongProbability, reworkCostTokens, remainingWorkTokens, usdPerToken, taskTokens, meanUncertainty,
  taskComplete, FAILURE_STEP, UNCERTAINTY_LOADING,
} from '../decision/utility.js';
import { assessDecisionTrust } from '../decision/trust.js';
import { contractOf } from './contracts.js';

export interface RiskSnapshot {
  /** Redo probability now — V(s)'s own number. */
  immediateFailureProbability: number;
  /** p at 1, 2, 4 and 8 decision steps ahead if nothing changes course. */
  shortHorizonFailureProbability: number[];
  /** Change in failure probability per state step (signed). */
  failureVelocity: number;
  /** Expected downstream loss on this trajectory, in tokens. */
  riskExposure: number;
  /** Recovery cost as a share of the task: how bad a failure would be. */
  failureSeverity: number;
  expectedRecoveryCostTokens: number;
  /** How committed the trajectory is: unvalidated work already done. */
  irreversibility: number;
  /** Doubt that the candidate set covers the useful interventions. */
  actionSpaceUncertainty: number;
  confidence: number;
  /** The state version this was taken at; velocity needs two of them. */
  stateVersion: number;
  /** Exposure attributed to each doubt dimension, in tokens. Sums to at most
   *  `riskExposure`; the rest is failure pressure no doubt dimension explains. */
  exposureByDimension: Record<UncertaintyKind, number>;
}

export const RISK_HORIZONS = [1, 2, 4, 8] as const;

/** How much of a change in risk the velocity estimate keeps from before.
 *  An exponential average over steps; half the weight on the newest reading. */
const VELOCITY_MEMORY = 0.5;

/** Option exposure's weight on information value (VOI × (1 + λ·OE)). One is
 *  the neutral prior: preserving a whole task's worth of options doubles what
 *  learning before committing is worth. A benchmark knob, not a gate. */
export const OPTION_LAMBDA = 1;

/** Commitment: work already done that nothing has proven. That is what a late
 *  discovery of a mistake throws away. */
export function commitmentDepth(state: EconomicState): number {
  if (taskComplete(state)) return 0;
  return clamp01(state.trajectory.progress * (1 - state.validation.confidence));
}

/** Where the exposure comes from.
 *
 *  p = 1 − (1 − fp)(1 − w): failure pressure, or a wrong result. The part doubt
 *  explains is exactly (1 − fp)·w; the rest is a run failing for reasons no
 *  evidence can buy down, and it stays unattributed.
 *
 *  Validation is the *summary* dimension — "do we know whether what we did is
 *  correct" — so a check can catch any upstream error and carries the whole
 *  doubt-explained exposure. The upstream doubts (target, structural,
 *  behavioural) are causes, and each carries its proportional share. The
 *  shares overlap by design; `riskReduction` combines them by noisy-OR so an
 *  action addressing two of them is never paid twice. */
function attribute(state: EconomicState, exposure: number): Record<UncertaintyKind, number> {
  const out = { target: 0, structural: 0, behavioral: 0, validation: 0 } as Record<UncertaintyKind, number>;
  const p = redoProbability(state);
  if (p <= 0 || exposure <= 0) return out;
  const fp = clamp01(state.trajectory.failurePressure);
  const doubtExplained = exposure * clamp01(((1 - fp) * wrongProbability(state)) / p);
  const total = UNCERTAINTY_KINDS.reduce((sum, k) => sum + state.uncertainty[k], 0);
  if (doubtExplained <= 0 || total <= 0) return out;
  for (const k of UNCERTAINTY_KINDS) out[k] = k === 'validation' ? doubtExplained : doubtExplained * (state.uncertainty[k] / total);
  return out;
}

/** The risk state at this boundary. `previous` is the snapshot from the last
 *  boundary on this run, when there was one: velocity is a difference, and a
 *  first reading has none. */
export function riskSnapshot(
  state: EconomicState,
  previous?: RiskSnapshot | null,
  actionSpaceUncertainty = 0,
  recalibrate: (p: number) => number = (p) => p,
): RiskSnapshot {
  const p0 = clamp01(recalibrate(redoProbability(state)));
  const steps = previous ? Math.max(1, state.version - previous.stateVersion) : 1;
  const raw = previous ? (p0 - previous.immediateFailureProbability) / steps : 0;
  const failureVelocity = previous
    ? VELOCITY_MEMORY * raw + (1 - VELOCITY_MEMORY) * previous.failureVelocity
    : 0;
  const shortHorizonFailureProbability = RISK_HORIZONS.map((k) => clamp01(p0 + failureVelocity * k));
  const recovery = taskComplete(state) ? 0 : reworkCostTokens(state);
  const worst = Math.max(p0, ...shortHorizonFailureProbability);
  const riskExposure = worst * recovery;
  return {
    immediateFailureProbability: p0,
    shortHorizonFailureProbability,
    failureVelocity,
    riskExposure,
    failureSeverity: recovery / Math.max(1, taskTokens(state)),
    expectedRecoveryCostTokens: recovery,
    irreversibility: commitmentDepth(state),
    actionSpaceUncertainty: clamp01(actionSpaceUncertainty),
    confidence: clamp01(state.trajectory.orchestrationConfidence),
    stateVersion: state.version,
    exposureByDimension: attribute(state, riskExposure),
  };
}

/** Failure probability `h` steps ahead if the run carries on as it is. */
export function failureAt(risk: RiskSnapshot, h: number): number {
  return clamp01(risk.immediateFailureProbability + risk.failureVelocity * Math.max(0, h));
}

/** V_r(s): the work left, plus the chance of redoing it — at the horizon the
 *  run will next be looked at — times what redoing costs. Equal to V(s) when
 *  risk is not moving. */
export function riskStateValue(state: EconomicState, risk: RiskSnapshot, horizon = 1): { tokens: number; usd: number } {
  if (taskComplete(state)) return { tokens: 0, usd: 0 };
  const tokens = remainingWorkTokens(state) + failureAt(risk, horizon) * risk.expectedRecoveryCostTokens;
  return { tokens, usd: tokens * usdPerToken(state) };
}

/** RiskReduction(a) = Σ_u Exposure(u) × Sensitivity(u,a) × EvidenceEffect(a,u),
 *  as the *fraction* of the current failure probability the action removes.
 *  Dimensions combine by noisy-OR, not by sum. `effectiveness` is what causal
 *  memory has learned about how well this intervention actually removes this
 *  doubt (1 = as declared). */
export function riskReduction(
  candidate: ActionCandidate,
  risk: RiskSnapshot,
  effectiveness: (fingerprint: string, kind: UncertaintyKind) => number = () => 1,
): number {
  if (risk.riskExposure <= 0) return 0;
  const contract = contractOf(candidate);
  const fingerprint = typeof candidate.metadata.fingerprint === 'string'
    ? candidate.metadata.fingerprint : `${candidate.kind}:${candidate.capability}:${candidate.id}`;
  let kept = 1;
  for (const kind of UNCERTAINTY_KINDS) {
    const sensitivity = contract.uncertaintyEffects[kind] ?? 0;
    if (sensitivity <= 0) continue;
    const share = clamp01(risk.exposureByDimension[kind] / risk.riskExposure);
    kept *= 1 - share * sensitivity * clamp01(effectiveness(fingerprint, kind));
  }
  return clamp01(1 - kept);
}

/** OE(a): the share of the task's value locked in after taking `a`. An
 *  information action moves no work forward, so it locks nothing in; carrying
 *  on locks in what the run will do before it is next looked at. */
export function optionExposure(state: EconomicState, candidate: ActionCandidate, horizon: number): number {
  const c = normalizeActionCandidate(candidate);
  const progressRate = clamp01(state.trajectory.progress) / Math.max(1, state.version || 1);
  const advance = c.kind === 'continue' ? progressRate * Math.max(1, horizon) : c.expectedProgress;
  return clamp01((state.trajectory.progress + advance) * (1 - state.validation.confidence));
}

/** CG(a) = OE(a) − OE(continue). Negative for anything that keeps options
 *  open relative to carrying on. */
export function commitmentGradient(state: EconomicState, candidate: ActionCandidate, horizon: number): number {
  return optionExposure(state, candidate, horizon)
    - optionExposure(state, { ...candidate, kind: 'continue', expectedProgress: 0 }, horizon);
}

function producesInformation(candidate: ActionCandidate): boolean {
  return contractOf(candidate).evidenceProduced.length > 0 && candidate.expectedProgress <= 0;
}

export interface RiskValuationOptions {
  /** Steps until the run is next looked at (the autonomy horizon). */
  horizon?: number;
  effectiveness?: (fingerprint: string, kind: UncertaintyKind) => number;
  /** Turn the option-exposure modulation off for ablation. */
  optionValue?: boolean;
  lambda?: number;
}

/** The market's signal level under the risk model, with V_r(s) beside it. Hand
 *  both to `chooseEconomicAction` as `valuation` and nothing else changes. */
export function riskValuation(state: EconomicState, risk: RiskSnapshot, options: RiskValuationOptions = {}): {
  signal: (candidate: ActionCandidate, state: EconomicState) => ActionTransitionEstimate;
  stateValueUsd: number;
} {
  const horizon = Math.max(1, options.horizon ?? 1);
  return {
    stateValueUsd: riskStateValue(state, risk, horizon).usd,
    signal: (candidate, s) => riskAwareEstimate(candidate, s, risk, { ...options, horizon }),
  };
}

/** One candidate, priced against expected downstream loss. Same outcome shape
 *  and bound construction as `signalEstimate`, with the loss term replaced. */
export function riskAwareEstimate(
  action: ActionCandidate,
  state: EconomicState,
  risk: RiskSnapshot,
  options: RiskValuationOptions = {},
): ActionTransitionEstimate {
  const candidate = normalizeActionCandidate(action);
  const horizon = Math.max(1, options.horizon ?? 1);
  const price = usdPerToken(state);
  const complete = taskComplete(state);
  const work = taskTokens(state);
  const R = risk.expectedRecoveryCostTokens;
  const remainingNow = remainingWorkTokens(state);
  const pNow = failureAt(risk, horizon);
  const current = complete ? 0 : remainingNow + pNow * R;

  // Channel 1: the contract's priced reduction, modulated by option value for
  // information gathered before the work commits.
  let byContract = riskReduction(candidate, risk, options.effectiveness);
  if (options.optionValue !== false && producesInformation(candidate)) {
    const gradient = -commitmentGradient(state, candidate, horizon);
    byContract = clamp01(byContract * (1 + (options.lambda ?? OPTION_LAMBDA) * Math.max(0, gradient)));
  }
  // Channel 2: the candidate's own claim about correctness.
  const byClaim = clamp01(candidate.expectedQualityBenefit) * clamp01(pNow);
  const reduction = Math.min(pNow, Math.max(byContract * pNow, byClaim));

  const succeeded = 1 - candidate.failureRisk;
  const progressAfter = clamp01(state.trajectory.progress + candidate.expectedProgress * (1 - state.trajectory.progress));
  const remainingAfter = Math.max(0, (1 - progressAfter) * work - candidate.expectedTokenBenefit);
  // Progress relieves failure pressure as it does in V(s); risk the action
  // adds (`qualityRisk`) is added back at the recovery price.
  const pAfter = clamp01(pNow - reduction - candidate.expectedProgress * clamp01(state.trajectory.failurePressure) * (1 - pNow)
    + candidate.qualityRisk);
  const successValue = complete ? 0 : remainingAfter + pAfter * R;
  const failureValue = complete ? 0 : remainingNow + clamp01(pNow + FAILURE_STEP) * R;
  const remaining = succeeded * successValue + (1 - succeeded) * failureValue;
  const immediate = candidate.tokenCost + candidate.coordinationCost + candidate.orchestrationCost;

  // The same doubt discipline as `signalEstimate`: a saving is believed only
  // as far as the candidate and the orchestrator deserve, and unresolved doubt
  // loads what is left. The cost side is never discounted.
  const trust = assessDecisionTrust({ state, action: candidate });
  const believed = Math.min(candidate.confidence, 1 - trust.risk, Math.max(risk.confidence, candidate.kind === 'continue' ? 1 : 0));
  const claimedSaving = Math.max(0, current - remaining);
  const upperTokens = immediate + remaining + (1 - believed) * claimedSaving
    + UNCERTAINTY_LOADING * meanUncertainty(state) * remaining;

  const quality = clamp01(1 - candidate.qualityRisk + candidate.expectedQualityBenefit);
  const lowerBound = clamp01(quality - (1 - candidate.confidence) * Math.sqrt(quality * (1 - quality)));

  return {
    actionId: candidate.id,
    immediateCost: { tokens: immediate, usd: immediate * price, latencyMs: candidate.latencyCost },
    outcomes: [
      {
        probability: succeeded, completed: false, succeeded: true,
        nextStateDelta: { progress: progressAfter - state.trajectory.progress, informationGain: candidate.expectedInformationGain },
      },
      ...(succeeded < 1 ? [{
        probability: 1 - succeeded, completed: false, succeeded: false,
        nextStateDelta: { failurePressure: FAILURE_STEP },
      }] : []),
    ],
    expectedRemainingCost: { tokens: remaining, usd: remaining * price, latencyMs: 0 },
    bounds: { successLowerBound: lowerBound, costUpperBoundUsd: upperTokens * price },
    confidence: believed,
    provenance: 'signal',
    evidenceIds: [],
  };
}

// ---------------------------------------------------------------------------
// Prevention value and the prevention frontier
// ---------------------------------------------------------------------------

export type PreventionTiming = 'not_justified' | 'too_early' | 'now' | 'near_commitment' | 'too_late';

export interface PreventionAssessment {
  /** Expected loss avoided now, minus what the action costs, in tokens. */
  valueNow: number;
  /** The same if the run is left alone for one more horizon first. */
  valueAfterWaiting: number;
  timing: PreventionTiming;
}

/** PreventionValue(a,t) = loss avoided − cost, now and one horizon later.
 *
 *  Waiting changes both sides: risk drifts by its velocity, and the recovery a
 *  failure would cost grows with the work committed meanwhile — but part of the
 *  loss may already have happened by then, which a later intervention cannot
 *  prevent. The frontier is where acting stops being worse than waiting, not
 *  the earliest boundary at which acting is possible. */
export function preventionValue(
  candidate: ActionCandidate,
  state: EconomicState,
  risk: RiskSnapshot,
  horizon = 1,
  effectiveness?: (fingerprint: string, kind: UncertaintyKind) => number,
): PreventionAssessment {
  const c = normalizeActionCandidate(candidate);
  const cost = c.tokenCost + c.coordinationCost + c.orchestrationCost;
  const share = riskReduction(c, risk, effectiveness);
  const h = Math.max(1, horizon);
  if (state.validation.status === 'failed' && share > 0 && c.kind !== 'recover') {
    // The failure this would have prevented has already been observed.
    return { valueNow: -cost, valueAfterWaiting: -cost, timing: 'too_late' };
  }
  const pNow = failureAt(risk, h);
  const valueNow = share * pNow * risk.expectedRecoveryCostTokens - cost;
  // After waiting: the work committed meanwhile raises the recovery price, and
  // the part of the failure that manifests in the meantime is no longer
  // preventable.
  const progressRate = clamp01(state.trajectory.progress) / Math.max(1, state.version || 1);
  const grownRecovery = risk.expectedRecoveryCostTokens
    + 0.5 * taskTokens(state) * Math.min(1 - state.trajectory.progress, progressRate * h);
  const pLater = failureAt(risk, 2 * h);
  const alreadyHappened = clamp01(pLater - pNow) * (risk.failureVelocity > 0 ? 1 : 0);
  const valueAfterWaiting = share * Math.max(0, pLater - alreadyHappened) * grownRecovery - cost;

  let timing: PreventionTiming;
  if (valueNow <= 0 && valueAfterWaiting <= 0) timing = 'not_justified';
  else if (valueNow <= 0) timing = 'too_early';
  else if (valueAfterWaiting > valueNow && risk.irreversibility < 0.5) timing = 'too_early';
  else timing = risk.irreversibility >= 0.5 ? 'near_commitment' : 'now';
  return { valueNow, valueAfterWaiting, timing };
}
