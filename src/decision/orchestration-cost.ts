/** What deciding costs.
 *
 *  The number every optimization layer leaves out, and the one that decides
 *  whether it was worth building. An orchestrator that screens on every event,
 *  evaluates deeply whenever it sees a flicker, and never writes down what that
 *  costs will always report itself as profitable — because the ledger it is
 *  measured by does not contain it.
 *
 *  Tokens here are *modelled*, latency is *measured*. That asymmetry is
 *  deliberate and the honest one: the decision layers are deterministic
 *  arithmetic over data already in memory and consume no model tokens at all,
 *  so a measured token figure would be zero and would flatter every ROI
 *  calculation to infinity. What they do consume is the runtime's own budget
 *  for *being* an orchestrator — the state it carries, the events it reduces,
 *  the candidates it builds — and charging a modelled price for that keeps the
 *  claim "optimization is cheap" falsifiable rather than definitional. */

export interface OrchestrationCost {
  tokens: number;
  latencyMs: number;
  /** What was actually done for this. `fast-path`, `fast-path+deep-path`,
   *  `skipped`. Machine-readable, because attributing an overhead regression
   *  means knowing which half of the loop grew. */
  reason: string;
}

export const FREE_ORCHESTRATION: OrchestrationCost = { tokens: 0, latencyMs: 0, reason: 'skipped' };

/** The screen. Small because it reads a handful of numbers off a state already
 *  in memory; non-zero because it runs on every event, and something that runs
 *  on every event and costs nothing is a claim nobody can check. */
export const FAST_PATH_TOKEN_COST = 4;

/** One deep evaluation, before its candidates. Matches
 *  `fast-path.ts`'s `DEEP_EVALUATION_TOKEN_COST`, which is what the screen
 *  budgets against — two different prices for the same operation would make the
 *  screen's economics wrong in whichever direction the difference went. */
export const DEEP_PATH_TOKEN_COST = 120;

/** Per candidate the deep path produced and the engine then priced. The
 *  marginal cost of considering one more option. */
export const PER_CANDIDATE_TOKEN_COST = 2;

export interface OrchestrationWork {
  fastPath: boolean;
  deepPath: boolean;
  candidates: number;
  latencyMs: number;
}

export function orchestrationCostOf(work: OrchestrationWork): OrchestrationCost {
  if (!work.fastPath && !work.deepPath) {
    return { ...FREE_ORCHESTRATION, latencyMs: Math.max(0, work.latencyMs) };
  }
  const tokens =
    (work.fastPath ? FAST_PATH_TOKEN_COST : 0)
    + (work.deepPath ? DEEP_PATH_TOKEN_COST + Math.max(0, work.candidates) * PER_CANDIDATE_TOKEN_COST : 0);
  return {
    tokens,
    latencyMs: Math.max(0, work.latencyMs),
    reason: work.deepPath ? 'fast-path+deep-path' : 'fast-path',
  };
}
