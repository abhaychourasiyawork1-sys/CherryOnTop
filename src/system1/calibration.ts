/** Provider probability → CherryOnTop probability.
 *
 *  A separate, versioned step so raw provider output is never mistaken for a
 *  probability calibrated on *this* workload, and one calibrator per surface,
 *  because a probability that is well calibrated for "does this split" says
 *  nothing about "is this action helpful".
 *
 *  Identity is the default, deliberately: Laya already applies its own
 *  per-type, per-option-count fitted temperatures, and re-applying temperature
 *  here would double-scale. A surface gets a fitted calibrator only once there
 *  is labelled CherryOnTop data to fit it on and a held-out measurement showing
 *  it helps.
 *
 *  `execution.decomposable` has one. Measured against live Laya on 40
 *  labelled goals (bench/system1-calibration), the raw probability ranked goals
 *  well (AUC 0.89) but sat on a biased centre: even single-unit tasks scored
 *  0.35–0.70, so every economic threshold split almost everything. Temperature
 *  scaling alone cannot move a centre, since it is symmetric around 0.5. Platt
 *  scaling (temperature plus a bias) can: leave-one-out log loss improved from
 *  0.569 to 0.492 and pipeline decision accuracy from 0.575 (the regex
 *  heuristic it replaces) to 0.700. Refit with `node bench/system1-calibrate.mjs`. */
import type { DecisionJudgment, DecisionSurface } from './types.js';

export const IDENTITY_VERSION = 'identity@1';
/** Kept for receipts and tests that name the default. */
export const CALIBRATION_VERSION = IDENTITY_VERSION;

interface Platt {
  version: string;
  /** For a two-way choice, the option whose probability is the proposition. */
  positive: string;
  a: number;
  b: number;
}

export const DECOMPOSABLE_PLATT: Platt = {
  version: 'platt-decomposable@1',
  positive: 'many',
  a: 4.7088,
  b: -1.1557,
};

const PLATT: Partial<Record<DecisionSurface, Platt>> = {
  'execution.decomposable': DECOMPOSABLE_PLATT,
};

const clamp01 = (p: number) => (Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0);

export function plattScale(p: number, c: Pick<Platt, 'a' | 'b'>): number {
  const q = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return 1 / (1 + Math.exp(-(c.a * Math.log(q / (1 - q)) + c.b)));
}

/** Returns a new judgment. `orchestration` is CherryOnTop's confidence in the
 *  state the question was asked about, kept beside, never multiplied into,
 *  the semantic probability. */
export function calibrate(judgment: DecisionJudgment, orchestration: number): DecisionJudgment {
  const platt = PLATT[judgment.surface];
  const result = { ...judgment.result };
  let raw = judgment.calibration.rawProbability;
  let calibrated: number | undefined;
  let version = IDENTITY_VERSION;

  if (platt && result.probabilities && platt.positive in result.probabilities && Object.keys(result.probabilities).length === 2) {
    // A two-way choice calibrated as the binary proposition it is, so the
    // pair still sums to one and the selection follows the calibrated odds.
    raw = clamp01(result.probabilities[platt.positive]);
    calibrated = plattScale(raw, platt);
    const other = Object.keys(result.probabilities).find((k) => k !== platt.positive)!;
    result.probabilities = { [platt.positive]: calibrated, [other]: 1 - calibrated };
    result.selectedId = calibrated >= 0.5 ? platt.positive : other;
    version = platt.version;
  } else {
    if (result.probability !== undefined) result.probability = clamp01(result.probability);
    if (result.probabilities) {
      result.probabilities = Object.fromEntries(Object.entries(result.probabilities).map(([k, v]) => [k, clamp01(v)]));
    }
    if (raw !== undefined) calibrated = clamp01(raw);
  }

  return {
    ...judgment,
    result,
    calibration: {
      ...(raw === undefined ? {} : { rawProbability: raw }),
      ...(calibrated === undefined ? {} : { calibratedProbability: calibrated }),
      version,
    },
    confidence: { provider: clamp01(judgment.confidence.provider), orchestration: clamp01(orchestration) },
  };
}
