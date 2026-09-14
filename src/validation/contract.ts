/** What "done" has to mean, and what it costs to establish.
 *
 *  The failure this exists to close is the cheapest one in the whole system to
 *  fall into: a run finishes, the process exits zero, and the runtime writes
 *  down that the task succeeded. Nothing checked anything. Every token metric
 *  downstream is then divided by a success count that includes runs which did
 *  not work — and since the primary KPI is *tokens per successful task*, an
 *  optimizer that makes runs cheaper and wronger scores as an improvement.
 *
 *  So completion is evidence-backed, and the evidence comes in levels with
 *  prices. The levels are **capability descriptions**, not a workflow: each says
 *  what kind of evidence it rests on and roughly what establishing it costs, and
 *  the engine buys the cheapest one that clears the floor. A task whose floor a
 *  green test in the trace already satisfies never pays to re-run it. */

/** Four levels, cheapest first.
 *
 *   - `V0` — **assertion**. The run said it worked. Free, and worth almost
 *     nothing: it is the claim being checked, not a check of it.
 *   - `V1` — **artifact**. Something durable exists: a file changed, output was
 *     produced. Free, because the runtime already recorded it. Establishes that
 *     work happened, not that it was right.
 *   - `V2` — **observed verification**. A verifying command ran green inside the
 *     run's own trace: a test, a build, a typecheck. Free for the same reason —
 *     it already happened — and much stronger, because something other than the
 *     agent agreed.
 *   - `V3` — **fresh verification**. Run the check again, now, against the tree
 *     as it stands. The only level that costs anything, and the only one immune
 *     to a run that verified an intermediate state and then broke it. */
export type ValidationLevel = 'V0' | 'V1' | 'V2' | 'V3';

export const VALIDATION_LEVELS: readonly ValidationLevel[] = ['V0', 'V1', 'V2', 'V3'];

export interface ValidationContract {
  /** The minimum probability the result is correct. Inherited from the economic
   *  state's own floor, so there is one answer to "how right does this have to
   *  be" rather than two. */
  qualityFloor: number;
  /** Checks a person named for this task — the definition of done. Descriptive:
   *  they raise what is required, never lower it. */
  requiredChecks: string[];
  /** How much doubt is tolerable. The complement of the floor in most cases,
   *  carried separately because a task can demand a high floor *and* accept
   *  reaching it by a cheap route. */
  allowedUncertainty: number;
}

export const DEFAULT_VALIDATION_CONTRACT: ValidationContract = {
  qualityFloor: 0.7,
  requiredChecks: [],
  allowedUncertainty: 0.3,
};

/** How much each level lets you believe, and what it costs to get.
 *
 *  The confidences are the load-bearing judgement in this file and are stated
 *  rather than derived, because there is nothing to derive them from: they are
 *  a claim about how much a kind of evidence is worth. Two properties matter
 *  more than the exact numbers. First, **V0 alone cannot clear a default
 *  floor** — that is what stops "the process exited zero" from becoming "the
 *  task succeeded". Second, the free levels are genuinely free, so a run that
 *  already proved itself pays nothing to say so.
 *
 *  `tokens` and `latencyMs` are what *establishing* the level costs now. V0-V2
 *  are zero because the evidence already exists; only V3 runs anything. */
export interface LevelModel {
  confidence: number;
  tokens: number;
  latencyMs: number;
}

export const LEVEL_MODEL: Record<ValidationLevel, LevelModel> = {
  // Deliberately below every sane floor. An unsupported claim is not evidence.
  V0: { confidence: 0.2, tokens: 0, latencyMs: 0 },
  // Work happened. Still short of a 0.7 floor on its own, because "a file
  // changed" and "the change is right" are different facts.
  V1: { confidence: 0.5, tokens: 0, latencyMs: 0 },
  // Something other than the agent agreed, inside the run's own trace.
  V2: { confidence: 0.85, tokens: 0, latencyMs: 0 },
  // Re-checked against the tree as it stands. Never 1: a passing test is
  // evidence, not proof, and rounding it to certainty would make the floor
  // unfalsifiable.
  V3: { confidence: 0.97, tokens: 2_000, latencyMs: 45_000 },
};

/** The confidence a contract demands.
 *
 *  The stricter of the two things it can say. A contract that sets a high floor
 *  and a generous uncertainty allowance means the floor; one that sets a low
 *  floor and demands near-certainty means the allowance. Taking the maximum is
 *  what makes both fields safe to set independently. */
export function requiredConfidence(contract: ValidationContract): number {
  return Math.max(
    Math.min(1, Math.max(0, contract.qualityFloor)),
    1 - Math.min(1, Math.max(0, contract.allowedUncertainty)),
  );
}
