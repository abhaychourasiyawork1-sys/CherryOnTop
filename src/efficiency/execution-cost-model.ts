/** What a dispatch is likely to cost, learned from what similar ones did.
 *
 *  The market prices a candidate from a scalar prior and, once it has history, a
 *  *mean* of past dispatches. A mean hides the thing a budgeted run cares about:
 *  the tail. A model whose typical dispatch is cheap and whose one-in-ten is
 *  three times dearer is a different bet when a run is capped by a spend limit
 *  than when it is not. So the estimate is a distribution — p50, p75, p90 —
 *  from segmented statistics, and the market prices at a risk-adjusted point
 *  between the median and the tail.
 *
 *  Deliberately not a regression. With a few dozen dispatches per segment a fitted
 *  model would be fitting noise, and a segment's empirical quantiles are
 *  something a person can read, dispute and correct. The segmentation gives the
 *  conditioning the features would (role, model, effort, task class) without
 *  pretending to a functional form.
 *
 *  Three properties are load-bearing:
 *
 *   - **Cold start returns nothing.** Below `MIN_SAMPLES` there is no estimate,
 *     and the caller keeps the static prior it always had. A quantile of three
 *     numbers is an anecdote.
 *   - **Specific before general, general never invented.** The estimate comes
 *     from the most specific segment with enough history; if none of the
 *     specific ones qualify it widens, and if even the widest does not, it is
 *     silent.
 *   - **Every dispatch counts, including the ones that died.** A run killed by
 *     its spend limit or a turn cap still spent its tokens. Leaving those out
 *     would price a model by its successes.
 *
 *  Pure: no I/O, no clock.
 */

export const COST_MODEL_VERSION = 'segmented-quantile-v1';

/** Below this a segment is not evidence. */
export const MIN_SAMPLES = 5;

export interface ExecutionCostFeatures {
  role: string;
  model?: string;
  effort?: string;
  taskClass?: string;
}

export interface CostSample extends ExecutionCostFeatures {
  /** Input + output tokens of one dispatch — the unit the market prices in. */
  tokens: number;
  /** Informational: a killed or failed run is a sample like any other. */
  outcome?: 'finished' | 'failed' | 'killed';
}

export interface CostQuantiles {
  p50: number;
  p75: number;
  p90: number;
  sampleCount: number;
  modelVersion: string;
  /** Which features the segment was conditioned on, e.g. `role+model+effort`. */
  segment: string;
}

/** Linear-interpolated quantile of an ascending array. NaN for an empty one. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const position = Math.min(1, Math.max(0, q)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

type Feature = 'model' | 'effort' | 'taskClass';

/** Segments, most specific first. `role` is always conditioned on: a planner and
 *  an executor are different dispatches. */
const SEGMENTS: Feature[][] = [
  ['model', 'effort', 'taskClass'],
  ['model', 'taskClass'],
  ['model', 'effort'],
  ['model'],
  [],
];

function segmentName(features: Feature[]): string {
  return ['role', ...features].join('+');
}

export function estimateQuantiles(
  samples: CostSample[],
  features: ExecutionCostFeatures,
  minSamples: number = MIN_SAMPLES,
): CostQuantiles | null {
  const usable = samples.filter((s) => s.role === features.role && Number.isFinite(s.tokens) && s.tokens > 0);
  for (const segment of SEGMENTS) {
    // A segment that conditions on a feature the caller did not supply is the
    // same as the one without it; skipping it avoids reporting a name for a
    // condition that was not applied.
    if (segment.some((f) => features[f] === undefined)) continue;
    const matching = usable.filter((s) => segment.every((f) => s[f] === features[f]));
    if (matching.length < minSamples) continue;
    const sorted = matching.map((s) => s.tokens).sort((a, b) => a - b);
    return {
      p50: quantile(sorted, 0.5), p75: quantile(sorted, 0.75), p90: quantile(sorted, 0.9),
      sampleCount: sorted.length, modelVersion: COST_MODEL_VERSION, segment: segmentName(segment),
    };
  }
  return null;
}

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** `p50 + λ·(p90 − p50)`: the median for no aversion to the tail, the p90 for
 *  total aversion. */
export function riskAdjusted(q: Pick<CostQuantiles, 'p50' | 'p90'>, lambda: number): number {
  return q.p50 + clamp01(lambda) * (q.p90 - q.p50);
}

/** How much the tail should count. More when the run is close to its budget
 *  (a p90 dispatch would not fit), more when the contract demands a result that
 *  is very likely right (running out of room is how that fails). A modest floor
 *  otherwise, so a relaxed run still leans slightly away from a heavy tail.
 *
 *  The coefficients are a starting position, not a finding: they are bounded to
 *  [0, 1] and monotone in both inputs, and the calibration record
 *  (`coverageOf`) is what says whether the resulting estimates were any good. */
export function riskAversion(input: { qualityFloor: number; budgetSpentShare: number }): number {
  return clamp01(0.15 + 0.35 * clamp01(input.qualityFloor) + 0.5 * clamp01(input.budgetSpentShare));
}

export interface CostPredictionRecord {
  predicted: CostQuantiles;
  actual: number;
}

export interface CostCoverage {
  n: number;
  /** Share of actuals at or below each predicted quantile. A calibrated model
   *  reads ≈0.5, ≈0.75, ≈0.9. */
  p50: number;
  p75: number;
  p90: number;
  medianRelativeError: number;
}

export function coverageOf(records: CostPredictionRecord[]): CostCoverage {
  if (records.length === 0) return { n: 0, p50: 0, p75: 0, p90: 0, medianRelativeError: 0 };
  const share = (pick: (q: CostQuantiles) => number) =>
    records.filter((r) => r.actual <= pick(r.predicted)).length / records.length;
  const errors = records
    .map((r) => Math.abs(r.actual - r.predicted.p50) / Math.max(1, r.predicted.p50))
    .sort((a, b) => a - b);
  return {
    n: records.length, p50: share((q) => q.p50), p75: share((q) => q.p75), p90: share((q) => q.p90),
    medianRelativeError: quantile(errors, 0.5),
  };
}
