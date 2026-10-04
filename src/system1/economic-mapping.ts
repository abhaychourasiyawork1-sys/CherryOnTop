/** Where a semantic probability meets deterministic economics, and the only
 *  place it does.
 *
 *  Two rules make this safe:
 *
 *   - A probability never multiplies a utility. It decides one uncertain
 *     semantic fact, and economics prices the consequences of being wrong
 *     about that fact in either direction.
 *   - A Choice preference is never a success probability, so nothing here
 *     accepts one. */
import type { DelegationPricing } from '../engines/decide-execution.js';
import type { ActionCandidate } from '../decision/actions.js';

export interface DecompositionBoundary {
  /** What the economics says a split is worth when the work really does split. */
  gain: number;
  /** What trying costs when it does not: the planning run that comes back
   *  "not delegatable". */
  waste: number;
  /** The probability at which trying and not trying are worth the same. */
  threshold: number;
}

/** The decision boundary for `execution.decomposable`, derived from what the
 *  market says each way of getting the work done costs rather than chosen:
 *  try splitting when `p·gain ≥ (1−p)·waste`, i.e. `p ≥ waste / (gain + waste)`.
 *
 *  `gain` is what a real split saves once the planner has been paid (solo work
 *  avoided, less the plan, the pieces and their combination); `waste` is the
 *  plan alone, spent when the work turns out not to split.
 *
 *  Null when even a certain "yes" could not make delegating cheaper. The answer
 *  cannot change the action, so the question is not worth asking. */
export function decompositionBoundary(pricing: DelegationPricing): DecompositionBoundary | null {
  const waste = pricing.plan.expectedUsd;
  const gain = pricing.solo.expectedUsd - pricing.plan.expectedUsd
    - pricing.children.expectedUsd - pricing.synth.expectedUsd;
  if (!Number.isFinite(gain) || !Number.isFinite(waste) || gain <= 0) return null;
  return { gain, waste, threshold: waste / (gain + waste) };
}

const TOLERANCE = 1e-9;

export function worthSplittingFrom(probability: number, boundary: DecompositionBoundary): boolean {
  return probability * boundary.gain >= (1 - probability) * boundary.waste - TOLERANCE;
}

const HELPFUL_KEY = 'system1Helpful';

/** An intervention whose benefit is weighted by the calibrated probability that
 *  it helps.
 *
 *  Only the *benefit* terms move. Costs are paid whether or not the action
 *  helps, and `failureRisk` is left alone because the question is asked
 *  conditioned on the action being carried out: execution failure is priced
 *  once, by the candidate, and helpfulness once, here. Applying it twice is
 *  refused rather than compounded. */
export function withHelpfulness(candidate: ActionCandidate, probability: number): ActionCandidate {
  if (candidate.metadata?.[HELPFUL_KEY] !== undefined) {
    throw new Error(`helpfulness already applied to ${candidate.id}`);
  }
  const p = Number.isFinite(probability) ? Math.min(1, Math.max(0, probability)) : 0;
  return {
    ...candidate,
    expectedProgress: candidate.expectedProgress * p,
    expectedInformationGain: candidate.expectedInformationGain * p,
    expectedTokenBenefit: candidate.expectedTokenBenefit * p,
    expectedQualityBenefit: candidate.expectedQualityBenefit * p,
    expectedLatencyBenefit: candidate.expectedLatencyBenefit * p,
    metadata: { ...candidate.metadata, [HELPFUL_KEY]: p },
  };
}
