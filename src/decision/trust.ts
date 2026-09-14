/** How much a decision deserves to be acted on, given how much it could cost to
 *  be wrong.
 *
 *  The failure this closes is specific and it is the one that makes automated
 *  optimization dangerous rather than merely useless: **an orchestrator that
 *  responds to not knowing what is going on by intervening harder.** It is an
 *  easy failure to build. Uncertainty raises the apparent value of acting —
 *  something must be wrong, so do something — and every term in a utility model
 *  points the same way. The result is a system whose interventions are most
 *  aggressive exactly where its information is worst.
 *
 *  So confidence is not one number here, it is three, and they can fail
 *  independently:
 *
 *   - **evidence** — how much the facts the decision rests on deserve belief.
 *   - **mechanism** — how much the estimate of *this action's* effect deserves
 *     belief.
 *   - **orchestration** — how much the orchestrator trusts its own reading of
 *     the run at all.
 *
 *  Against them sits **consequence**: how much would be lost if the decision is
 *  wrong. A free, reversible action needs almost no trust — being wrong costs
 *  nothing. One that spends a fifth of the budget, or lowers the chance the
 *  result is correct, needs a great deal.
 *
 *  `risk = consequence × (1 - trust)` is the whole model, and its important
 *  property is the one the failure above lacks: as confidence falls, risk
 *  rises, and the *expensive* interventions become ineligible first. Doubt
 *  narrows what may be done rather than widening it.
 *
 *  Deterministic and total: no model, no clock, no I/O. */
import { clamp01 } from '../efficiency/policy-types.js';
import type { ActionCandidate } from './actions.js';
import type { EconomicState } from './state.js';

export interface TrustAssessment {
  evidenceConfidence: number;
  mechanismConfidence: number;
  orchestrationConfidence: number;
  /** [0,1]. How much is at stake if this is wrong. */
  consequence: number;
  /** [0,1]. Consequence discounted by trust. The number a caller gates on. */
  risk: number;
  reasonCodes: string[];
}

/** What "no evidence" is worth.
 *
 *  The neutral middle, not zero. A run that has observed nothing has told us
 *  nothing about how reliable its observations are, and scoring that as *bad
 *  evidence* would make every first decision maximally risky — which would stop
 *  the cheap early interventions that are the ones most likely to pay. Being
 *  unsure must look like being unsure. */
const NO_EVIDENCE_CONFIDENCE = 0.5;

/** How much of the run's remaining resources an action puts at stake.
 *
 *  Against what is *left*, not against the total: spending a thousand tokens
 *  with ninety thousand to go is a different decision from spending a thousand
 *  with twelve hundred to go, and a share of the total calls them the same. */
function resourceConsequence(action: ActionCandidate, state: EconomicState): number {
  const remaining = state.resources.remainingTokens;
  if (remaining <= 0) return action.tokenCost + action.coordinationCost > 0 ? 1 : 0;
  return clamp01((action.tokenCost + action.coordinationCost) / remaining);
}

/** Facts the decision rests on, and how much they deserve belief.
 *
 *  Weighted towards *validated* evidence: something checked is worth more than
 *  something asserted, and averaging them flat lets a pile of guesses outvote a
 *  test. */
export function evidenceConfidenceOf(state: EconomicState): number {
  if (state.evidence.length === 0) return NO_EVIDENCE_CONFIDENCE;
  const weight = (kind: string) => (kind === 'validation' ? 2 : kind === 'fact' ? 1.5 : 1);
  const total = state.evidence.reduce((sum, ref) => sum + weight(ref.kind), 0);
  const weighted = state.evidence.reduce((sum, ref) => sum + weight(ref.kind) * ref.confidence, 0);
  return clamp01(weighted / total);
}

export function assessDecisionTrust(input: {
  state: EconomicState;
  action: ActionCandidate;
}): TrustAssessment {
  const { state, action } = input;
  const reasonCodes: string[] = [];

  const evidenceConfidence = evidenceConfidenceOf(state);
  const mechanismConfidence = clamp01(action.confidence);
  const orchestrationConfidence = clamp01(state.trajectory.orchestrationConfidence);

  // The weakest link, softened. A minimum would make one bad number veto
  // everything; a mean would let two good ones hide it. The geometric mean sits
  // between: it is dragged down hard by a low term without being pinned to it.
  const trust = clamp01((evidenceConfidence * mechanismConfidence * orchestrationConfidence) ** (1 / 3));

  // What is at stake. Three independent ways an action can be consequential,
  // and the largest governs — a cheap action that could make the result wrong
  // is not made safe by being cheap.
  const resource = resourceConsequence(action, state);
  const quality = clamp01(action.qualityRisk);
  // Something that cannot be undone is consequential whatever it costs. Named
  // in metadata rather than as a field, like every other capability-specific
  // fact, so that adding an irreversible capability needs no change here.
  const irreversible = action.metadata.irreversible === true ? 1 : 0;
  const consequence = Math.max(resource, quality, irreversible);

  if (resource >= quality && resource >= irreversible && resource > 0) reasonCodes.push('consequence:resources');
  if (quality > resource && quality >= irreversible) reasonCodes.push('consequence:quality');
  if (irreversible > 0) reasonCodes.push('consequence:irreversible');

  const risk = clamp01(consequence * (1 - trust));

  // Which confidence is the weak one, so a receipt can say what to fix rather
  // than only that something was distrusted.
  const weakest = Math.min(evidenceConfidence, mechanismConfidence, orchestrationConfidence);
  if (weakest === evidenceConfidence && evidenceConfidence < 0.5) reasonCodes.push('low_evidence_confidence');
  if (weakest === mechanismConfidence && mechanismConfidence < 0.5) reasonCodes.push('low_mechanism_confidence');
  if (weakest === orchestrationConfidence && orchestrationConfidence < 0.5) reasonCodes.push('low_orchestration_confidence');

  return {
    evidenceConfidence,
    mechanismConfidence,
    orchestrationConfidence,
    consequence,
    risk,
    reasonCodes,
  };
}

/** What a utility score is worth once trust is taken into account.
 *
 *  A multiplier rather than a gate, applied where actions are *ranked* rather
 *  than inside `evaluateActionUtility`. Two reasons, and both matter:
 *
 *   - The utility model answers "what is this worth?", which is a question
 *     about the action. Trust answers "should we believe that?", which is a
 *     question about us. Mixing them makes neither answerable on its own.
 *   - A gate here would be a second hard constraint competing with the one in
 *     `fallback.ts`, and two places that can refuse an action for
 *     insufficient confidence is one place too many.
 *
 *  Discounting towards zero, never past it: distrusting a loss does not turn it
 *  into a gain. */
export function trustAdjusted(score: number, trust: TrustAssessment): number {
  return score * (1 - trust.risk);
}
