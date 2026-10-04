import { describe, it, expect } from 'vitest';
import {
  buildCounterfactualObservation, hasCounterfactual, summarizeCalibration,
  type CounterfactualInput, calibrateTransitions } from './counterfactual.js';
import type { CandidateOutcomeObservation } from './hierarchical.js';

function input(over: Partial<CounterfactualInput> = {}): CounterfactualInput {
  return {
    chosen: 'MANAGED', alternative: 'SERIAL_DELEGATED',
    predictedCostUsd: 0.15, predictedLatencyMs: 120_000, predictedSuccessProbability: 0.8,
    actualCostUsd: 0.21, actualLatencyMs: 150_000, actualSucceeded: true,
    validationLevel: 'V2', recoveryCount: 0,
    ...over,
  };
}

describe('buildCounterfactualObservation', () => {
  it('records economic prediction error after verified completion', () => {
    const observation = buildCounterfactualObservation(input())!;
    expect(observation.predictionError.costUsd).toBeCloseTo(0.06);
  });

  it('signs the error so positive always means "worse than promised"', () => {
    const overspent = buildCounterfactualObservation(input({ actualCostUsd: 0.21 }))!;
    const underspent = buildCounterfactualObservation(input({ actualCostUsd: 0.09 }))!;
    expect(overspent.predictionError.costUsd).toBeGreaterThan(0);
    expect(underspent.predictionError.costUsd).toBeLessThan(0);
    expect(buildCounterfactualObservation(input({ actualLatencyMs: 200_000 }))!.predictionError.latencyMs)
      .toBeGreaterThan(0);
  });

  it('measures surprise against the predicted probability', () => {
    expect(buildCounterfactualObservation(input({ actualSucceeded: true }))!.predictionError.successProbability)
      .toBeCloseTo(0.2);
    expect(buildCounterfactualObservation(input({ actualSucceeded: false }))!.predictionError.successProbability)
      .toBeCloseTo(-0.8);
  });

  it('keeps success-after-recovery distinguishable from clean success', () => {
    expect(buildCounterfactualObservation(input({ recoveryCount: 0 }))!.outcome).toBe('SUCCESS');
    expect(buildCounterfactualObservation(input({ recoveryCount: 2 }))!.outcome).toBe('SUCCESS_WITH_RECOVERY');
    expect(buildCounterfactualObservation(input({ actualSucceeded: false }))!.outcome).toBe('FAILURE');
  });

  it('records nothing for a decision a rule made rather than a score', () => {
    // A hard gate did not predict anything. A "prediction error" for it would
    // manufacture evidence that arithmetic was wrong when none ran.
    expect(buildCounterfactualObservation(input({ scored: false }))).toBeNull();
  });

  it('records nothing when there was no real alternative', () => {
    expect(buildCounterfactualObservation(input({ alternative: 'MANAGED' }))).toBeNull();
    expect(hasCounterfactual({ chosen: 'MANAGED', alternative: 'MANAGED' })).toBe(false);
  });

  it('carries the single term that would have flipped the decision', () => {
    const observation = buildCounterfactualObservation(input({
      breakdown: {
        score: 0.2, threshold: 0.3, modelCost: 0.1, latencyCost: 0.05,
        coordinationCost: 0.15, verificationCost: 0.1, riskPenalty: 0,
      },
    }))!;
    expect(observation.margin?.margin).toBeCloseTo(0.1);
    expect(observation.margin?.wouldHave).toBe('delegated');
  });

  it('carries no margin when there was no breakdown to read one from', () => {
    expect(buildCounterfactualObservation(input())!.margin).toBeNull();
  });

  it('takes the actual side from measurement, never from the prediction', () => {
    const observation = buildCounterfactualObservation(input({
      predictedCostUsd: 1, actualCostUsd: 0.21, predictedLatencyMs: 1, actualLatencyMs: 150_000,
    }))!;
    expect(observation.actual.costUsd).toBe(0.21);
    expect(observation.actual.latencyMs).toBe(150_000);
    // If actuals were ever inferred from estimates, this would be zero.
    expect(observation.predictionError.costUsd).not.toBe(0);
  });

  it('records the validation level the outcome was established at', () => {
    expect(buildCounterfactualObservation(input({ validationLevel: 'V3' }))!.actual.validationLevel).toBe('V3');
  });
});

describe('summarizeCalibration', () => {
  it('says "no observations" rather than "no bias" when there is nothing', () => {
    const summary = summarizeCalibration([]);
    expect(summary.observations).toBe(0);
    expect(summary.meanCostErrorUsd).toBeNull();
    expect(summary.recoveryRate).toBeNull();
  });

  it('exposes a systematic under-pricing across runs of one shape', () => {
    const summary = summarizeCalibration([
      buildCounterfactualObservation(input({ actualCostUsd: 0.25 }))!,
      buildCounterfactualObservation(input({ actualCostUsd: 0.21 }))!,
      buildCounterfactualObservation(input({ actualCostUsd: 0.23 }))!,
    ]);
    expect(summary.observations).toBe(3);
    expect(summary.meanCostErrorUsd).toBeGreaterThan(0.05);
  });

  it('reports how often the strategy only worked after recovery', () => {
    const summary = summarizeCalibration([
      buildCounterfactualObservation(input({ recoveryCount: 1 }))!,
      buildCounterfactualObservation(input({ recoveryCount: 0 }))!,
    ]);
    expect(summary.recoveryRate).toBeCloseTo(0.5);
  });
});

describe('transition calibration: predicted against actual, grouped', () => {
  const obs = (candidateId: string, predicted: number, actual: number, validity: CandidateOutcomeObservation['validity'] = 'VALID'): CandidateOutcomeObservation => ({
    candidateId, task: [{ level: 'TASK_SHAPE', value: 'refactor:high' }], stateSignature: 's',
    predicted: { costUsd: predicted, latencyMs: 10, successProbability: 0.9, progress: 1 },
    actual: { costUsd: actual, latencyMs: 15, succeeded: true, validated: true, progress: 0.8, tokens: 1 },
    recoveryCount: 0, validationLevel: 'V2', validity,
  });

  it('detects a candidate that is consistently under-priced for a shape of work', () => {
    const byCandidate = calibrateTransitions([
      obs('cheap-model', 0.1, 0.4), obs('cheap-model', 0.1, 0.5), obs('sound-model', 0.3, 0.3),
    ], (o) => o.candidateId);
    expect(byCandidate['cheap-model'].meanCostErrorUsd).toBeCloseTo(0.35);
    expect(byCandidate['sound-model'].meanCostErrorUsd).toBeCloseTo(0);
    expect(byCandidate['cheap-model'].meanLatencyErrorMs).toBe(5);
    expect(byCandidate['cheap-model'].meanSuccessError).toBeCloseTo(0.1);
    expect(byCandidate['cheap-model'].meanProgressError).toBeCloseTo(-0.2);
  });

  it('groups by any key — task shape, state signature — with the same arithmetic', () => {
    const byShape = calibrateTransitions([obs('a', 0.1, 0.2), obs('b', 0.2, 0.2)], (o) => o.task[0].value);
    expect(byShape['refactor:high'].observations).toBe(2);
  });

  it('keeps invalid observations visible and out of the averages', () => {
    const result = calibrateTransitions([obs('a', 0.1, 0.2), obs('a', 0.1, 99, 'INVALID_INFRA')], (o) => o.candidateId);
    expect(result.a).toEqual(expect.objectContaining({ observations: 1, excluded: 1 }));
    expect(result.a.meanCostErrorUsd).toBeCloseTo(0.1);
  });
});
