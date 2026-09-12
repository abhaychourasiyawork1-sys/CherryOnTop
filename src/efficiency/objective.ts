/** Turning a pile of efficiency records into a verdict.
 *
 *  Two currencies (tokens, wall-clock) and two things that must not be paid
 *  with them (success rate, quality). The objective combines the first pair;
 *  the second pair are gates, not terms — a weighted score can always be
 *  improved by spending quality, so quality must sit outside the arithmetic
 *  where no weighting can trade it away.
 *
 *  Everything here is a pure function over records. Running the corpus that
 *  produces them costs real money and is a separate, deliberate act. */
import type { EfficiencyRecord } from './metrics.js';

export interface ObjectiveWeights {
  tokens: number;
  latency: number;
}

/** Tokens are the primary metric and latency the secondary, but not by much:
 *  a change that halves spend and doubles the wait is not obviously a win. */
export const DEFAULT_WEIGHTS: ObjectiveWeights = { tokens: 0.6, latency: 0.4 };

export interface SuiteSummary {
  tasks: number;
  successRate: number;
  /** Null when nothing in the run was scored. Never invented. */
  qualityScore: number | null;
  tokensPerSuccessfulTask: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  cacheHitRatio: number;
  coordinationTokenShare: number;
  recoveryTokenShare: number;
  synthesisAvoidanceRatio: number;
  /** Summed across the run: tokens a previous identical dispatch had already
   *  paid for. The direct measure of reuse. */
  tokensAvoided: number;
  workAvoidedRatio: number;
  /** Startup over time inside dispatches, averaged. The measurement that
   *  decides whether warm-sandbox work is worth building. */
  executionOverheadRatio: number;
  /** Dispatch time over elapsed time. Above 1 means work genuinely overlapped. */
  concurrencyEfficiency: number;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Nearest-rank percentile. No interpolation: with the handful of tasks a
 *  corpus like this has, an interpolated p95 is a number no run produced. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

export function summarizeRun(records: EfficiencyRecord[]): SuiteSummary {
  const successful = records.filter((r) => r.outcome === 'success');
  const scored = records.map((r) => r.qualityScore).filter((q): q is number => q !== null);
  const dispatchMs = records.reduce((sum, r) => sum + r.dispatchMs, 0);
  const elapsedMs = records.reduce((sum, r) => sum + r.endToEndMs, 0);

  return {
    tasks: records.length,
    successRate: records.length === 0 ? 0 : successful.length / records.length,
    qualityScore: scored.length === 0 ? null : mean(scored),
    // Per *successful* task: a change that halves tokens by failing twice as
    // often has not improved anything, and a plain average would hide it.
    tokensPerSuccessfulTask: mean(successful.map((r) => r.totalTokens)),
    // Latency over every task, successful or not — a person waits for failures
    // too, and a change that makes failures slow is a change that made things
    // worse.
    p50LatencyMs: percentile(records.map((r) => r.endToEndMs), 50),
    p95LatencyMs: percentile(records.map((r) => r.endToEndMs), 95),
    cacheHitRatio: mean(records.map((r) => r.cacheHitRatio)),
    coordinationTokenShare: mean(records.map((r) => r.coordinationTokenShare)),
    recoveryTokenShare: mean(records.map((r) => r.recoveryTokenShare)),
    synthesisAvoidanceRatio: mean(records.map((r) => r.synthesisAvoidanceRatio)),
    tokensAvoided: records.reduce((sum, r) => sum + r.tokensAvoided, 0),
    workAvoidedRatio: mean(records.map((r) => r.workAvoidedRatio)),
    executionOverheadRatio: mean(records.map((r) => r.executionOverheadRatio)),
    concurrencyEfficiency: elapsedMs === 0 ? 0 : dispatchMs / elapsedMs,
  };
}

/** `J`, normalized against the baseline, so the baseline always scores 1 and
 *  anything below it is an improvement. Ratios rather than absolute units
 *  because the two terms are measured in tokens and milliseconds, and adding
 *  those together only means something once both are dimensionless. */
export function objectiveScore(summary: SuiteSummary, baseline: SuiteSummary, weights: ObjectiveWeights): number {
  const ratio = (value: number, base: number) => (base <= 0 ? 1 : value / base);
  const total = weights.tokens + weights.latency;
  if (total <= 0) return 1;
  return (
    weights.tokens * ratio(summary.tokensPerSuccessfulTask, baseline.tokensPerSuccessfulTask) +
    weights.latency * ratio(summary.p95LatencyMs, baseline.p95LatencyMs)
  ) / total;
}

export interface ExperimentInput {
  baseline: SuiteSummary;
  optimized: SuiteSummary;
  weights: ObjectiveWeights;
  /** How much success rate may fall before the change is refused. */
  epsilon: number;
}

export interface ExperimentResult {
  accepted: boolean;
  objectiveBaseline: number;
  objectiveOptimized: number;
  tokenDeltaPct: number;
  p50LatencyDeltaPct: number;
  p95LatencyDeltaPct: number;
  successDeltaPct: number;
  qualityDelta: number;
  /** Every gate that failed, or why it passed. */
  reason: string;
}

function deltaPct(optimized: number, baseline: number): number {
  return baseline === 0 ? 0 : ((optimized - baseline) / baseline) * 100;
}

export function evaluateExperiment(input: ExperimentInput): ExperimentResult {
  const { baseline, optimized, weights, epsilon } = input;
  const objectiveBaseline = objectiveScore(baseline, baseline, weights);
  const objectiveOptimized = objectiveScore(optimized, baseline, weights);

  const failures: string[] = [];

  // Silence is not a pass. An unscored optimized run must not be able to ship a
  // quality regression by simply not measuring one — but a baseline that was
  // never scored has no bar to clear, and demanding one would block every
  // experiment run before scoring existed.
  if (baseline.qualityScore !== null) {
    if (optimized.qualityScore === null) failures.push('quality was not scored on the optimized run');
    else if (optimized.qualityScore < baseline.qualityScore) failures.push('quality regressed');
  }

  if (optimized.successRate < baseline.successRate - epsilon) {
    failures.push(`success rate fell more than ${epsilon}`);
  }

  if (objectiveOptimized >= objectiveBaseline) failures.push('the objective did not improve');

  return {
    accepted: failures.length === 0,
    objectiveBaseline,
    objectiveOptimized,
    tokenDeltaPct: deltaPct(optimized.tokensPerSuccessfulTask, baseline.tokensPerSuccessfulTask),
    p50LatencyDeltaPct: deltaPct(optimized.p50LatencyMs, baseline.p50LatencyMs),
    p95LatencyDeltaPct: deltaPct(optimized.p95LatencyMs, baseline.p95LatencyMs),
    successDeltaPct: deltaPct(optimized.successRate, baseline.successRate),
    qualityDelta: (optimized.qualityScore ?? 0) - (baseline.qualityScore ?? 0),
    reason: failures.length === 0 ? 'every gate passed and the objective improved' : failures.join('; '),
  };
}
