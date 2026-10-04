import { uninformedDifficulty } from './difficulty.js';

export interface IntelligenceBundle {
  sufficientContext: boolean;
  /** [0,1]: how hard the work is believed to be (`difficulty.ts`). Not read
   *  from the goal's wording. */
  difficulty: number;
  /** The calibrated probability, from System-1, that the work comes apart into
   *  independent pieces. Absent means nobody has said, and the node does the
   *  work itself rather than pay a planner to be told it does not split. */
  splitProbability?: number;
  /** The named signals behind that call, carried into the decision record. */
  signals: Record<string, number>;
}

// Doc §6: "intelligence proportional to uncertainty" — no Evidence/Capability/
// Runtime-Intelligence workers exist yet (that's the rest of the Intelligence
// Plane, later phases), so this is deliberately only the "nothing is known"
// leg: the work is as hard as an uninformed belief says and nobody has said it
// splits. sufficientContext is always true for v0.1: there is no research step
// to wait on, so INTELLIGENCE_GATE never has a reason to loop back to PLAN yet.
// Reading the goal's characters or words here would put a guess where a
// judgment belongs — see `system1/decomposability.ts` for who owns the verdict.
export function assessUncertainty(_input: { goal: string }): IntelligenceBundle {
  return { sufficientContext: true, difficulty: uninformedDifficulty().value, signals: {} };
}
