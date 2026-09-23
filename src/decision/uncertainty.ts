/** Four doubts, tracked apart, and what it is worth to remove any of them.
 *
 *  The reason this is not one number: the four have different *cures*. A run
 *  that does not know what it was asked cannot be helped by reading more files;
 *  a run that knows exactly what to change but not whether the change works
 *  cannot be helped by reading the goal again. Averaged into one confidence
 *  score, both look like "0.5 unsure" and the orchestrator picks whichever cure
 *  it happens to favour.
 *
 *  Two properties the update rule has to have, and both are easy to get wrong:
 *
 *   - **Independence.** Evidence about structure must not move behavioral
 *     doubt. Anything else lets a cheap `ls` launder itself into confidence
 *     about correctness.
 *   - **No free repetition.** Reading the same file twice must reduce doubt
 *     once. Without this, a run in a loop steadily convinces itself it
 *     understands the problem *because* it is stuck — which is the exact
 *     inversion of the truth, and it arrives right when the orchestrator most
 *     needs to be told to intervene. */
import { clamp01 } from '../efficiency/policy-types.js';
import type { UncertaintyKind, UncertaintyState, UncertaintyObservation } from './state.js';

export type { UncertaintyObservation };

export const UNCERTAINTY_KINDS: readonly UncertaintyKind[] = ['target', 'structural', 'behavioral', 'validation'];

/** How the value of removing doubt is shaped.
 *
 *  `curvature` is the exponent on doubt in the cost-of-being-wrong function.
 *  At 1 the model is linear: removing 0.3 of doubt is worth three times
 *  removing 0.1, wherever on the scale it happens. Above 1, doubt is
 *  *disproportionately* costly when it is high — which is the honest reading of
 *  how these runs actually fail. A run that has no idea where the code lives
 *  wastes its whole budget; a run that is 90% sure wastes a few turns
 *  confirming. So resolving 0.8 → 0.5 is worth much more than three times
 *  resolving 0.2 → 0.1, and a linear model would price the two the same way per
 *  unit and buy the wrong evidence.
 *
 *  Configurable rather than baked in because it is a claim about this
 *  repository's failure modes, and the benchmark is what should settle it. */
export interface EvidenceModel {
  curvature: number;
}

export const DEFAULT_EVIDENCE_MODEL: EvidenceModel = { curvature: 1.5 };

/** What removing doubt from `before` to `after` is worth, on [0,1].
 *
 *  Zero when doubt did not fall — evidence that confirmed what we already
 *  believed is not worthless, but it is not *uncertainty reduction*, and
 *  counting it as such is how a run pays twice for the same knowledge. */
export function uncertaintyValue(
  before: number,
  after: number,
  model: EvidenceModel = DEFAULT_EVIDENCE_MODEL,
): number {
  const b = clamp01(before);
  const a = clamp01(after);
  if (a >= b) return 0;
  const curvature = Number.isFinite(model.curvature) && model.curvature > 0 ? model.curvature : 1;
  return clamp01(b ** curvature - a ** curvature);
}

/** Total value across every dimension, for comparing two pieces of evidence
 *  that address different doubts. */
export function totalUncertaintyValue(
  before: UncertaintyState,
  after: UncertaintyState,
  model: EvidenceModel = DEFAULT_EVIDENCE_MODEL,
): number {
  return UNCERTAINTY_KINDS.reduce((sum, kind) => sum + uncertaintyValue(before[kind], after[kind], model), 0);
}

/** Identity of an observation for the purpose of "have we already counted
 *  this?". The dimension *and* the evidence behind it: the same file read twice
 *  is one observation, while the same file telling us about structure and about
 *  behaviour is two. */
function signatureOf(observation: UncertaintyObservation): string {
  return `${observation.kind}#${[...new Set(observation.sourceEvidenceIds ?? [])].sort().join(',')}`;
}

/** How much an observation is trusted given that the world may have moved since
 *  it was made.
 *
 *  `before` is the observer's account of the doubt it was addressing. When that
 *  disagrees with the doubt actually held, the observation was computed against
 *  a state that no longer exists — a decision made three events ago, arriving
 *  now. It is not discarded (it may still be the best information available),
 *  but it is believed in proportion to how well its premise still holds. */
function staleness(observation: UncertaintyObservation, current: number): number {
  if (!Number.isFinite(observation.before)) return 1;
  return clamp01(1 - Math.abs(clamp01(observation.before) - current));
}

/** The next uncertainty state, given what was observed.
 *
 *  `alreadyCounted` is the set of evidence ids whose effect is already in
 *  `current`. Pure rather than stateful: the caller owns the ledger of what has
 *  been counted, which is what lets the same function serve the state reducer,
 *  a replay, and a what-if comparison without any of them sharing memory. */
export function updateUncertainty(
  current: UncertaintyState,
  observations: UncertaintyObservation[],
  alreadyCounted: Iterable<string> = [],
): UncertaintyState {
  if (!observations || observations.length === 0) return { ...current };

  const counted = new Set(alreadyCounted);
  const seen = new Set<string>();
  const next = { ...current };

  for (const observation of observations) {
    if (!observation || !UNCERTAINTY_KINDS.includes(observation.kind)) continue;

    const ids = observation.sourceEvidenceIds ?? [];
    // Every piece of evidence behind this observation has already been counted,
    // so the doubt it removes is already gone. Re-applying it would let a loop
    // manufacture confidence out of repetition.
    if (ids.length > 0 && ids.every((id) => counted.has(id))) continue;

    // And the same within one call: a producer that emitted the same
    // observation twice gets it applied once.
    const signature = signatureOf(observation);
    if (seen.has(signature)) continue;
    seen.add(signature);

    const weight = clamp01(observation.confidence) * staleness(observation, next[observation.kind]);
    // Moves *towards* what was observed, by how much it is believed. Never past
    // it, and never below zero: doubt is bounded and an over-eager observer
    // must not be able to drive it negative.
    next[observation.kind] = clamp01(
      next[observation.kind] + (clamp01(observation.after) - next[observation.kind]) * weight,
    );
  }

  return next;
}
