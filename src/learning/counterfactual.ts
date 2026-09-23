/** What the decision predicted, what actually happened, and the gap.
 *
 *  `engines/economics.ts` can already say how close a decision was to its
 *  threshold — which term was load-bearing, and by how much. That is the
 *  strongest evidence we have that the reasoning is real, and it is still only
 *  half the loop: it explains the decision, and says nothing about whether the
 *  numbers it rested on were any good.
 *
 *  This closes it. At terminal validation, the chosen strategy's *prediction*
 *  is written down next to the *measurement*, and the difference becomes
 *  evidence for the next economic decision of the same shape. So a receipt can
 *  eventually answer the question that matters: "we chose managed because
 *  delegation looked more expensive — and managed then cost 40% more than we
 *  said it would, on every task like this."
 *
 *  Two rules hold it honest:
 *
 *   - **Only scored decisions.** A hard gate did not predict anything; it
 *     applied a rule. Recording a "prediction error" for it would manufacture
 *     evidence that the arithmetic was wrong when no arithmetic ran.
 *   - **Only measured actuals.** The actual side comes from telemetry, never
 *     from the estimate that produced the prediction — comparing an estimate to
 *     itself is a loop that always reports perfect accuracy.
 *
 *  Deterministic and total: no clock, no database, no model. */
import { counterfactual, type Counterfactual } from '../engines/economics.js';
import type { ExecutionStrategy } from '../decision/strategy-gate.js';
import type { ValidationLevel } from '../validation/contract.js';
import { outcomeKindOf, type StrategyOutcomeKind } from './hierarchical.js';

export interface CounterfactualInput {
  chosen: ExecutionStrategy;
  /** The strategy that was actually available and lost. A strategy no gate
   *  would have allowed is not an alternative, and pretending it was one makes
   *  the counterfactual a fiction. */
  alternative: ExecutionStrategy;
  predictedCostUsd: number;
  predictedLatencyMs: number;
  predictedSuccessProbability: number;
  actualCostUsd: number;
  actualLatencyMs: number;
  actualSucceeded: boolean;
  validationLevel: ValidationLevel;
  recoveryCount: number;
  /** False when a rule rather than a score decided this. */
  scored?: boolean;
  /** The economics breakdown, when there was one. Lets the record carry which
   *  single term would have flipped the decision, from the existing helper
   *  rather than from a second implementation of the same arithmetic. */
  breakdown?: Record<string, number>;
}

export interface CounterfactualObservation {
  chosen: ExecutionStrategy;
  alternative: ExecutionStrategy;
  predicted: {
    costUsd: number;
    latencyMs: number;
    successProbability: number;
  };
  actual: {
    costUsd: number;
    latencyMs: number;
    succeeded: boolean;
    validationLevel: ValidationLevel;
    recoveryCount: number;
  };
  /** Actual minus predicted, always in that order. Positive cost error means
   *  it cost *more* than promised; positive latency error means it took
   *  longer. Fixing the sign convention here is what stops every consumer
   *  having to remember it. */
  predictionError: {
    costUsd: number;
    latencyMs: number;
    successProbability: number;
  };
  /** Clean success, success that needed recovery, or failure. A strategy that
   *  only ever works on the second attempt must not read as one that works. */
  outcome: StrategyOutcomeKind;
  /** The single change that would have produced the opposite decision, when
   *  there was a score to move. */
  margin: Counterfactual | null;
}

/** Whether this decision has a counterfactual worth recording at all.
 *
 *  Three ways it does not: a rule decided it, there was no alternative, or the
 *  "alternative" is the thing that was chosen. */
export function hasCounterfactual(input: Pick<CounterfactualInput, 'chosen' | 'alternative' | 'scored'>): boolean {
  return input.scored !== false && input.alternative !== input.chosen;
}

export function buildCounterfactualObservation(input: CounterfactualInput): CounterfactualObservation | null {
  if (!hasCounterfactual(input)) return null;

  return {
    chosen: input.chosen,
    alternative: input.alternative,
    predicted: {
      costUsd: input.predictedCostUsd,
      latencyMs: input.predictedLatencyMs,
      successProbability: input.predictedSuccessProbability,
    },
    actual: {
      costUsd: input.actualCostUsd,
      latencyMs: input.actualLatencyMs,
      succeeded: input.actualSucceeded,
      validationLevel: input.validationLevel,
      recoveryCount: Math.max(0, input.recoveryCount),
    },
    predictionError: {
      costUsd: input.actualCostUsd - input.predictedCostUsd,
      latencyMs: input.actualLatencyMs - input.predictedLatencyMs,
      // The outcome is 1 or 0; the prediction was a probability. The difference
      // is the surprise, and averaging it over many runs is calibration.
      successProbability: (input.actualSucceeded ? 1 : 0) - input.predictedSuccessProbability,
    },
    outcome: outcomeKindOf({ success: input.actualSucceeded, recoveryCount: input.recoveryCount }),
    // Reuses the existing helper rather than recomputing threshold arithmetic a
    // second time: two implementations of one formula is two answers.
    margin: input.breakdown ? counterfactual(input.breakdown) : null,
  };
}

/** How wrong the economic model has been, over many runs of the same shape.
 *
 *  A mean, not a sum: the question is "does this model systematically
 *  under-price this shape of work", and a sum answers "how much work have we
 *  done". Returns nulls rather than zeros when there is nothing to average,
 *  because "no bias observed" and "no observations" are different claims. */
export interface CalibrationSummary {
  observations: number;
  meanCostErrorUsd: number | null;
  meanLatencyErrorMs: number | null;
  meanSuccessError: number | null;
  /** Fraction of runs that needed recovery to succeed. */
  recoveryRate: number | null;
}

export function summarizeCalibration(observations: CounterfactualObservation[]): CalibrationSummary {
  if (observations.length === 0) {
    return {
      observations: 0, meanCostErrorUsd: null, meanLatencyErrorMs: null,
      meanSuccessError: null, recoveryRate: null,
    };
  }
  const mean = (pick: (o: CounterfactualObservation) => number) =>
    observations.reduce((sum, o) => sum + pick(o), 0) / observations.length;

  return {
    observations: observations.length,
    meanCostErrorUsd: mean((o) => o.predictionError.costUsd),
    meanLatencyErrorMs: mean((o) => o.predictionError.latencyMs),
    meanSuccessError: mean((o) => o.predictionError.successProbability),
    recoveryRate: observations.filter((o) => o.outcome === 'SUCCESS_WITH_RECOVERY').length / observations.length,
  };
}
