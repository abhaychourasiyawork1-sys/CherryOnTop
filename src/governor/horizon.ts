/** How long to leave the agent alone.
 *
 *  The harness does not decide what the agent does next; it decides when it is
 *  next worth asking whether to intervene at all. That interval is priced, not
 *  scheduled:
 *
 *      look again when the loss that could accumulate unobserved reaches what
 *      looking costs.
 *
 *  Unobserved loss accrues at g tokens per state step. Two sources: an error
 *  that is already there grows its rework by about one step of work for every
 *  step it goes unnoticed (p × tokens per step), and rising risk moves failure
 *  probability mass onto the full recovery cost (velocity × R). So
 *  h* = ⌈cost of a look / g⌉. A look's cost is the deep evaluation plus the
 *  regret a look risks — an unnecessary intervention — as learned from past
 *  tasks; looking is never free just because the arithmetic is cheap. A healthy run (low risk, steady)
 *  gets a long horizon and the governor all but disappears; a run whose risk is
 *  rising and whose work is committing gets a short one. There is no fixed
 *  "every N turns", and horizon expiry means only "re-evaluate whether
 *  governance is worth buying" — `continue` remains a normal winner there.
 *
 *  Event-based on top: a material transition (a new failure, a validation
 *  result, a hard stop) makes the next boundary due regardless of the horizon,
 *  because the premise the horizon was priced on no longer holds. */
import { clamp01 } from '../efficiency/policy-types.js';
import type { EconomicState } from '../decision/state.js';
import { DEEP_EVALUATION_TOKEN_COST } from '../decision/fast-path.js';
import type { RiskSnapshot } from './risk.js';

export interface AutonomyHorizon {
  /** State steps until the next look. */
  horizon: number;
  /** The state version at which the next look becomes due. */
  dueAtVersion: number;
  /** Tokens of unobserved loss expected per step, the denominator. */
  lossRatePerStep: number;
  reason: 'priced' | 'no_exposure' | 'material_transition' | 'first_look';
}

/** When nothing yet says how long the run is, the longest the horizon may be.
 *  Replaced by the run's own expected remaining steps as soon as progress gives
 *  a rate. A ceiling on not-knowing, not a schedule. */
export const UNKNOWN_RUN_LENGTH_STEPS = 16;

/** Steps the run is expected to have left, from its own rate of progress. */
export function expectedRemainingSteps(state: EconomicState): number {
  const progress = clamp01(state.trajectory.progress);
  if (progress <= 0 || state.version <= 0) return UNKNOWN_RUN_LENGTH_STEPS;
  return Math.max(1, Math.ceil((state.version / progress) * (1 - progress)));
}

export function autonomyHorizon(input: {
  state: EconomicState;
  risk: RiskSnapshot | null;
  /** What one look costs in tokens; the deep path's own price by default. */
  lookCostTokens?: number;
}): AutonomyHorizon {
  const { state, risk } = input;
  const cost = Math.max(1, input.lookCostTokens ?? DEEP_EVALUATION_TOKEN_COST);
  const ceiling = expectedRemainingSteps(state);
  if (!risk) return { horizon: 1, dueAtVersion: state.version + 1, lossRatePerStep: 0, reason: 'first_look' };
  const R = risk.expectedRecoveryCostTokens;
  const perStep = state.version > 0 ? state.resources.consumedTokens / state.version : 0;
  const rising = Math.max(0, risk.failureVelocity) * R;
  const growing = risk.immediateFailureProbability * perStep;
  const rate = rising + growing;
  if (rate <= 0) return { horizon: ceiling, dueAtVersion: state.version + ceiling, lossRatePerStep: 0, reason: 'no_exposure' };
  const horizon = Math.max(1, Math.min(ceiling, Math.ceil(cost / rate)));
  return { horizon, dueAtVersion: state.version + horizon, lossRatePerStep: rate, reason: 'priced' };
}

/** What a horizon was priced against, carried to the next boundary so a
 *  changed premise can be recognised. */
export interface HorizonPremise {
  failurePressure: number;
  validationStatus: EconomicState['validation']['status'];
  hardStop: boolean;
}

export function premiseOf(state: EconomicState): HorizonPremise {
  return {
    failurePressure: state.trajectory.failurePressure,
    validationStatus: state.validation.status,
    hardStop: state.constraints.hardStop,
  };
}

/** A new failure, a validation result, or a stop: the run is no longer the run
 *  the horizon was priced for. */
export function materialTransition(premise: HorizonPremise | null, state: EconomicState): boolean {
  if (!premise) return true;
  return state.trajectory.failurePressure > premise.failurePressure + 1e-9
    || state.validation.status !== premise.validationStatus
    || state.constraints.hardStop !== premise.hardStop;
}
