/** What a boundary is allowed to do (H2.6 D1, bench/governor/h26/DESIGN.md §2).
 *
 *  Three predicates, deliberately separate, because conflating them is how the
 *  first boundary of every real run became a blind no-op:
 *
 *   - **observable** — the governor may look: the cycle ran, a decision (often
 *     `continue`) and its packet are recorded. True at every evaluated
 *     boundary, the first included.
 *   - **interventionEligible** — interventions may be priced as feasible. Needs
 *     telemetry from the run itself. When false, the market's own
 *     `missing_telemetry` fault keeps refusing every intervention exactly as
 *     before; this module only names the fact once per boundary.
 *   - **recoverEligible** — additionally, a failure from a *completed* dispatch
 *     and a recover candidate `evaluateRecovery` justified. Never true at the
 *     first boundary, because no dispatch has completed there.
 *
 *  Pure. Nothing here relaxes a refusal. */
import type { ActionCandidate } from '../decision/actions.js';
import type { EconomicState } from '../decision/state.js';

/** The once-per-boundary marker for an intervention-ineligible boundary. */
export const INELIGIBLE_NO_TELEMETRY = 'ineligible:no_telemetry';

/** The cycle evaluated this boundary: it was due and produced a decision. */
export function observable(cycle: { decision?: unknown; cost: { reason: string } }): boolean {
  return cycle.decision !== undefined && cycle.cost.reason !== 'not_due' && cycle.cost.reason !== 'reentrant';
}

/** `economicStateFor` sets orchestrationConfidence = min(goal confidence,
 *  actions / 5), so it is positive exactly when the run has recorded at least
 *  one action *and* the goal reading is not zero — the same condition under
 *  which `detectFaults` stops emitting `missing_telemetry`. */
export function interventionEligible(state: Pick<EconomicState, 'trajectory'>): boolean {
  return state.trajectory.orchestrationConfidence > 0;
}

/** A recover candidate the boundary's own recovery evaluation justified: it
 *  carries the failure signature it was evaluated against (see
 *  `recoveryCandidates` in economic-runtime.ts). The generic `deep:recover`
 *  does not, and does not make a boundary recover-eligible on its own. */
export function justifiedRecover(candidate: ActionCandidate): boolean {
  return candidate.kind === 'recover' && typeof candidate.metadata.failureSignature === 'string';
}

export interface RecoverEligibilityFacts {
  state: Pick<EconomicState, 'trajectory'>;
  /** Execute dispatches of this node that have finished (usage recorded). */
  completedDispatches: number;
  /** The failure signature the boundary's snapshot holds, or null. */
  failureSignature: string | null;
  candidates: readonly ActionCandidate[];
}

/** Why a boundary is not recover-eligible, or null when it is. The §5 safety
 *  rules are checked on top of this by the experiment, not here. */
export function recoverIneligibility(facts: RecoverEligibilityFacts): string | null {
  if (!interventionEligible(facts.state)) return 'intervention-eligible';
  if (facts.completedDispatches < 1 || !facts.failureSignature) return 'a-real-retry';
  if (!facts.candidates.some(justifiedRecover)) return 'a-real-retry';
  return null;
}

export function recoverEligible(facts: RecoverEligibilityFacts): boolean {
  return recoverIneligibility(facts) === null;
}
