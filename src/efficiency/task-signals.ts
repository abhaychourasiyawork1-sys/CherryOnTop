/** The boundary that makes every other number in this subsystem safe to read.
 *
 *  Signals are derived from a goal string, which is to say from a guess. The
 *  scorer, the policies and the guard all weight them against each other, and
 *  that arithmetic only means something if every term is finite and lives on
 *  the same [0,1] scale. So nothing enters the system without coming through
 *  here.
 *
 *  The defaults are the middle, never an extreme. "We could not tell" must
 *  behave like uncertainty, not like a confident zero — a missing confidence
 *  read as 0 would widen every selection, and read as 1 would prune every one. */
import { clamp01, type TaskEconomicsSignals } from './policy-types.js';

const BANDS: TaskEconomicsSignals['complexityBand'][] = ['tiny', 'small', 'medium', 'large', 'unknown'];

/** What a task looks like when nothing could be told about it. */
export const UNKNOWN_SIGNALS: TaskEconomicsSignals = {
  confidence: 0.5,
  breadth: 0.5,
  hasExplicitAnchors: false,
  expectedModificationScope: 0.5,
  investigationLikelihood: 0.5,
  verificationNeed: 0.5,
  // Not read-only until something says so: assuming a task writes nothing is
  // the assumption that costs an unwanted edit, not a few extra tokens.
  readOnly: false,
  complexityBand: 'unknown',
};

export function normalizeTaskSignals(raw: Partial<TaskEconomicsSignals>): TaskEconomicsSignals {
  const band = raw.complexityBand;
  return {
    confidence: clamp01(raw.confidence as number, UNKNOWN_SIGNALS.confidence),
    breadth: clamp01(raw.breadth as number, UNKNOWN_SIGNALS.breadth),
    hasExplicitAnchors: raw.hasExplicitAnchors === true,
    expectedModificationScope: clamp01(raw.expectedModificationScope as number, UNKNOWN_SIGNALS.expectedModificationScope),
    investigationLikelihood: clamp01(raw.investigationLikelihood as number, UNKNOWN_SIGNALS.investigationLikelihood),
    verificationNeed: clamp01(raw.verificationNeed as number, UNKNOWN_SIGNALS.verificationNeed),
    readOnly: raw.readOnly === true,
    complexityBand: band !== undefined && BANDS.includes(band) ? band : 'unknown',
  };
}
