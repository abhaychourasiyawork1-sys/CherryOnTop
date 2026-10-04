/** What makes the runtime unable to trust its own reading of a run.
 *
 *  This used to decide between two architectures — act on the decision, or "do
 *  what Baseline would have done". There is one architecture now, and a fault
 *  is simply a fact the market prices like any other: while one is present,
 *  every *intervention* is infeasible and the null action is what remains
 *  (see `hardConstraints` in `utility.ts`). Not optimizing is always safe;
 *  that is the whole of the old fallback, without a second mode to test.
 *
 *  Safety is deliberately not a fault. An unsafe action is refused by its own
 *  hard constraint — running it "unoptimized" would run it anyway. */
import type { EconomicState } from './state.js';
import type { DecisionFault } from './utility.js';

export type { DecisionFault } from './utility.js';

/** Faults readable from the state itself. Everything else the caller observed
 *  (a failed read, an invalid memory row) arrives as `faults` on the market
 *  input.
 *
 *  Total: a state this cannot read at all is itself missing telemetry, which is
 *  the correct answer rather than an exception. */
export function detectFaults(state: EconomicState): DecisionFault[] {
  const faults: DecisionFault[] = [];
  try {
    // No basis at all for reading this run — an absence of signal, as opposed
    // to a signal of absence.
    if (state.trajectory.orchestrationConfidence <= 0) faults.push('missing_telemetry');

    // Evidence about a revision the run is no longer on: a decision resting on
    // it is a decision about a tree that has moved.
    if (state.repositoryRevision) {
      const stale = state.evidence.some((ref) =>
        ref.repositoryRevision !== undefined && ref.repositoryRevision !== state.repositoryRevision);
      if (stale) faults.push('stale_repository_graph');
    }
  } catch {
    return ['missing_telemetry'];
  }
  return faults;
}
