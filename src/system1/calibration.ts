/** Provider probability → CherryOnTop probability.
 *
 *  A separate, versioned step so raw provider output is never mistaken for a
 *  probability calibrated on *this* workload. The first calibrator is the
 *  identity, deliberately: Laya has already applied its own per-type,
 *  per-option-count fitted temperatures, and a second temperature pass here
 *  would double-scale. A fitted per-surface calibrator replaces this once
 *  CherryOnTop's own outcomes exist to fit it on, and the version in every
 *  receipt says which one produced a number. */
import type { DecisionJudgment, DecisionSurface } from './types.js';

export const CALIBRATION_VERSION = 'identity@1';

type Calibrator = (p: number) => number;

const clamp01 = (p: number) => (Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0);

/** One calibrator per surface, because a probability that is well calibrated
 *  for "is this decomposable" says nothing about "is this action helpful". */
const CALIBRATORS: Record<DecisionSurface, Calibrator> = {
  'execution.decomposable': clamp01,
  'action.helpful': clamp01,
  'runtime.next_action': clamp01,
  'model.request': clamp01,
};

/** Returns a new judgment. `orchestration` is CherryOnTop's confidence in the
 *  state the question was asked about, kept beside, never multiplied into,
 *  the semantic probability. */
export function calibrate(judgment: DecisionJudgment, orchestration: number): DecisionJudgment {
  const f = CALIBRATORS[judgment.surface];
  const raw = judgment.calibration.rawProbability;
  const result = { ...judgment.result };
  if (result.probability !== undefined) result.probability = f(result.probability);
  if (result.probabilities) {
    result.probabilities = Object.fromEntries(Object.entries(result.probabilities).map(([k, v]) => [k, f(v)]));
  }
  return {
    ...judgment,
    result,
    calibration: {
      ...(raw === undefined ? {} : { rawProbability: raw, calibratedProbability: f(raw) }),
      version: CALIBRATION_VERSION,
    },
    confidence: { provider: clamp01(judgment.confidence.provider), orchestration: clamp01(orchestration) },
  };
}
