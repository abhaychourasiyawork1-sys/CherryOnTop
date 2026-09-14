/** What to do when the optimizer cannot be trusted.
 *
 *  The answer is always the same, and that is the design: **do what Baseline
 *  would have done.** Not a degraded mode, not a reduced-aggression mode, not a
 *  special path for missing telemetry and another for a stale graph. Every one
 *  of those would be a new behaviour to test, a new state for a run to be in,
 *  and a new place for a bug to hide — and the whole value of having a Baseline
 *  is that it is the behaviour that already works.
 *
 *  So there is one fallback with many reasons. The reasons are recorded because
 *  "Full Architecture fell back on 30% of tasks" and "on which" is the
 *  difference between a benchmark result that can be acted on and one that can
 *  only be reported.
 *
 *  The exception, and it is the important one: **a safety failure is not a
 *  reason to fall back.** Falling back means running unoptimized, and an action
 *  that violates a hard safety constraint is just as unsafe unoptimized. The
 *  response to that is to refuse the action, which is why `safetyPreserved`
 *  exists as a separate answer from `mode` rather than being implied by it. */
import type { EconomicState } from './state.js';
import type { ActionDecision } from './actions.js';

/** Every reason the optimizer stands down, named. Closed on purpose: an open
 *  string would make "why did this fall back?" unanswerable in aggregate, which
 *  is the only form in which the question is useful. */
export type FallbackReason =
  /** The signals the decision needs were not available or not readable. */
  | 'missing_telemetry'
  /** The repository evidence is about a revision that is no longer current. */
  | 'stale_repository_graph'
  /** Stored knowledge failed its own validity check. */
  | 'invalid_memory'
  /** The decision layer itself threw. */
  | 'decision_engine_error'
  /** Acquiring evidence failed in a way that leaves the run's state unclear. */
  | 'evidence_mechanism_error'
  /** A hard safety constraint was violated. The one reason falling back is not
   *  a sufficient response. */
  | 'safety_violation'
  /** Nothing was wrong; the decision simply was not confident enough to be
   *  worth acting on. */
  | 'insufficient_confidence'
  /** The optimizer has spent what it was allowed to spend on deciding. */
  | 'optimization_budget_exhausted';

/** The two modes the product has. Not a spectrum: see `config/efficiency.ts`. */
export type RuntimeArchitecture = 'baseline' | 'full';

export interface FallbackDecision {
  mode: RuntimeArchitecture;
  /** The reasons, joined. Empty string when nothing fell back. */
  reason: string;
  /** **Whether falling back is a sufficient response.**
   *
   *  True for every ordinary fault: running unoptimized is safe, so Baseline
   *  behaviour resolves it. False for a safety violation, where running
   *  unoptimized would run the unsafe action anyway — there the caller must
   *  refuse the action rather than merely stop optimizing it. Separate from
   *  `mode` precisely so that distinction cannot be lost by a caller that only
   *  checks which mode it is in. */
  safetyPreserved: boolean;
  /** Machine-readable, for aggregation. `reason` is the same information for a
   *  person to read. */
  reasons: FallbackReason[];
}

export const FULL_ARCHITECTURE: FallbackDecision = {
  mode: 'full', reason: '', safetyPreserved: true, reasons: [],
};

/** How much confidence a decision needs before it is worth acting on.
 *
 *  Not a constant: the bar is what the action *costs*. A free decision — narrow
 *  the search, continue — needs almost none, because being wrong costs nothing.
 *  One that spends a fifth of the remaining budget needs most of the way to
 *  certainty. Expressed as the share of remaining resources the action would
 *  consume, so it scales with the task rather than with a number someone picked.
 *
 *  This is the mechanism the plan calls "orchestrator uncertainty must reduce
 *  intervention aggressiveness": as confidence falls, the set of actions that
 *  clear the bar shrinks from the top down — the expensive ones go first. */
export function confidenceRequiredFor(decision: ActionDecision, state: EconomicState): number {
  const remaining = state.resources.remainingTokens;
  if (remaining <= 0) return 1;
  const share = (decision.action.tokenCost + decision.action.coordinationCost) / remaining;
  return Math.min(1, Math.max(0, share));
}

export interface FallbackInput {
  state: EconomicState;
  /** Absent when no decision was produced at all, which is itself a reason. */
  decision?: ActionDecision;
  /** Faults the caller observed and this module cannot see for itself: a read
   *  that failed, a graph that did not match the revision, a row that failed
   *  its own validity check. */
  faults?: FallbackReason[];
}

/** Whether to act on the decision, or to do what Baseline would have done.
 *
 *  Total and deterministic. Nothing here throws — a fallback evaluator that can
 *  fail is a fallback evaluator that needs a fallback. */
export function evaluateFallback(input: FallbackInput): FallbackDecision {
  const reasons: FallbackReason[] = [...(input.faults ?? [])];
  const { state, decision } = input;

  // Safety first, and checked before anything else, because it is the one
  // reason whose answer is not "run unoptimized".
  const unsafe = reasons.includes('safety_violation')
    || decision?.reasonCodes.includes('safety_violation') === true;
  if (decision?.reasonCodes.includes('safety_violation') && !reasons.includes('safety_violation')) {
    reasons.push('safety_violation');
  }

  if (!decision) reasons.push('missing_telemetry');

  if (state.resources.optimizationTokens > 0
      && state.resources.optimizationConsumedTokens >= state.resources.optimizationTokens) {
    reasons.push('optimization_budget_exhausted');
  }

  if (decision && decision.action.kind !== 'continue' && decision.action.kind !== 'stop') {
    if (decision.confidence < confidenceRequiredFor(decision, state)) {
      reasons.push('insufficient_confidence');
    }
  }

  if (reasons.length === 0) return FULL_ARCHITECTURE;

  // Deduplicated and ordered, so two runs that fell back for the same reasons
  // produce the same string and a comparison can group on it.
  const unique = [...new Set(reasons)].sort();
  return {
    mode: 'baseline',
    reason: unique.join('; '),
    safetyPreserved: !unsafe,
    reasons: unique,
  };
}

/** True when the caller must refuse the action outright rather than run it
 *  without optimization.
 *
 *  One predicate rather than a convention about reading two fields, so a caller
 *  cannot get the distinction wrong by checking only `mode`. */
export function mustBlockAction(fallback: FallbackDecision): boolean {
  return !fallback.safetyPreserved;
}
