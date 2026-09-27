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
import { defaultEconomicsInput, type DecideExecutionInput } from '../engines/decide-execution.js';
import { scoreDelegation } from '../engines/economics.js';
import type { ActionCandidate } from '../decision/actions.js';

type Complexity = DecideExecutionInput['complexity'];

export interface DecompositionBoundary {
  /** What the economics says a split is worth when the work really does split. */
  gain: number;
  /** What trying costs when it does not: the planning run that comes back
   *  "not delegatable". */
  waste: number;
  /** The probability at which trying and not trying are worth the same. */
  threshold: number;
}

/** The decision boundary for `execution.decomposable`, derived from the
 *  existing delegation economics rather than chosen: try splitting when
 *  `p·gain ≥ (1−p)·waste`, i.e. `p ≥ waste / (gain + waste)`.
 *
 *  Null when even a certain "yes" could not make economics delegate. The
 *  answer cannot change the action, so the question is not worth asking. */
export function decompositionBoundary(complexity: Complexity): DecompositionBoundary | null {
  const input = defaultEconomicsInput(complexity);
  const economics = scoreDelegation(input);
  if (!economics.delegate || economics.score <= 0) return null;
  const waste = input.modelCost + input.latencyCost;
  return { gain: economics.score, waste, threshold: waste / (economics.score + waste) };
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
