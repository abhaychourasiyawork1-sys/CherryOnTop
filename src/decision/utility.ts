/** Is this action worth taking, and is it allowed at all?
 *
 *  Two questions, deliberately answered in that order and reported separately.
 *  The order is the whole design: **hard constraints are evaluated before the
 *  score and cannot be bought by it.** A constraint a good enough number can
 *  overturn is not a constraint, it is a weight — and the failure mode of
 *  economic optimization is precisely that quality and safety get quietly
 *  re-priced as weights and then traded away for tokens.
 *
 *  The score itself is `Tokens : Quality : Latency = 2 : 2 : 1`, which is the
 *  objective this architecture was approved under. Three things make that
 *  arithmetic mean something:
 *
 *   - **Commensurate units.** Tokens are normalized against the task's own
 *     budget and milliseconds against its own latency budget, so a weighting
 *     can be read without holding a units table in your head. Adding raw tokens
 *     to raw milliseconds is how a 2:2:1 weighting silently becomes 2000:2:1.
 *   - **Cost in the same units as benefit.** Coordination and orchestration
 *     overhead are charged here, not elsewhere. An optimizer whose own cost is
 *     accounted somewhere it never reads will always look profitable.
 *   - **Discounting moves towards zero, never past it.** Being unsure about a
 *     loss does not turn it into a gain.
 *
 *  Deterministic and total: no model, no clock, no I/O. This runs on the hot
 *  path of the thing being optimized, and a per-candidate LLM judge is the one
 *  shape of optimization that cannot pay for itself. */
import { clamp01 } from '../efficiency/policy-types.js';
import { normalizeActionCandidate, type ActionCandidate } from './actions.js';
import type { EconomicState } from './state.js';

export interface UtilityWeights {
  tokens: number;
  quality: number;
  latency: number;
}

/** 2 : 2 : 1. Tokens are the primary KPI and quality is its equal, because a
 *  cheaper incorrect task is a regression rather than a saving; latency matters
 *  half as much as either, because a person waiting is a real cost and not the
 *  one this work was commissioned to move.
 *
 *  Deviation from the plan's literal interface, recorded deliberately: the spec
 *  typed these as the literal types `0.4 | 0.4 | 0.2`, which makes the `weights`
 *  parameter unusable — the only value assignable is the default itself. Typed
 *  as `number` the parameter does what it is for, and the 2:2:1 contract is
 *  pinned by test on this constant instead of by a type nobody can satisfy. */
export const DEFAULT_UTILITY_WEIGHTS: UtilityWeights = { tokens: 0.4, quality: 0.4, latency: 0.2 };

export interface UtilityEvaluation {
  /** False when any hard constraint fired. Independent of `score`: an action
   *  can be both profitable and forbidden, and collapsing the two would hide
   *  exactly the case worth seeing. */
  allowed: boolean;
  score: number;
  /** The positive half of the score, before cost. Reported so a receipt can say
   *  *why* something was close rather than only that it was. */
  expectedBenefit: number;
  expectedCost: number;
  qualityFloorSatisfied: boolean;
  safetySatisfied: boolean;
  /** Every constraint that fired, and the terms that dominated. Machine-readable
   *  and stable — this is what a benchmark attributes a regression with. */
  reasonCodes: string[];
}

/** The latency budget assumed when a task has none. Ten minutes: long enough
 *  that an ordinary dispatch does not saturate the term, short enough that a
 *  two-minute saving still registers. Only a normalizer — no behaviour is gated
 *  on it, and a task that declares its own budget never sees it. */
const NOMINAL_LATENCY_BUDGET_MS = 600_000;

/** The token scale assumed when a task has no budget at all. Same role: a
 *  divisor that keeps the term dimensionless rather than a bound on anything. */
const NOMINAL_TOKEN_SCALE = 10_000;

/** Actions that consume nothing and so can never be refused for affordability.
 *  Letting the agent continue, or stopping, must stay available to a task that
 *  has spent everything — otherwise the runtime's response to an exhausted
 *  budget would be to have no legal action at all. */
const FREE_ACTIONS: ReadonlySet<string> = new Set(['continue', 'stop', 'constrain', 'serialize']);

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** What this action can spend without eating the recovery reserve.
 *
 *  The reserve is capacity held back for a retry that is worth making, so
 *  ordinary work may not touch it — but recovery obviously may, since spending
 *  it is what it was held back for. */
function affordable(state: EconomicState, kind: string): number {
  const reserve = kind === 'recover' ? 0 : state.resources.recoveryReserve;
  return Math.max(0, state.resources.remainingTokens - reserve);
}

/** The probability the result is still correct if this action is taken.
 *
 *  Measured from a clean 1 rather than from the run's current quality, on
 *  purpose. The floor is a property of the *result*, and an action that adds no
 *  risk cannot breach it however uncertain the run currently is — anchoring to
 *  current quality instead would reject every action at the start of a task,
 *  when validation uncertainty is total by definition. */
function projectedQuality(candidate: ActionCandidate): number {
  return clamp01(1 - candidate.qualityRisk + candidate.expectedQualityBenefit);
}

export function evaluateActionUtility(
  action: ActionCandidate,
  state: EconomicState,
  weights: UtilityWeights = DEFAULT_UTILITY_WEIGHTS,
): UtilityEvaluation {
  const candidate = normalizeActionCandidate(action);
  const reasonCodes: string[] = [];

  // ---- hard constraints, before anything is scored -------------------------

  const hardStopped = state.constraints.hardStop && candidate.kind !== 'stop';
  if (hardStopped) reasonCodes.push('hard_stop');

  const unsafe = candidate.metadata.unsafe === true;
  if (unsafe) reasonCodes.push('safety_violation');

  const needsApproval = candidate.metadata.requiresApproval === true;
  if (needsApproval) reasonCodes.push('requires_approval');

  const qualityFloorSatisfied = projectedQuality(candidate) >= state.constraints.qualityFloor;
  if (!qualityFloorSatisfied) reasonCodes.push('quality_floor');

  const spend = candidate.tokenCost + candidate.coordinationCost;
  const affordableTokens = FREE_ACTIONS.has(candidate.kind)
    ? Number.POSITIVE_INFINITY
    : affordable(state, candidate.kind);
  const affordableAction = spend <= affordableTokens;
  if (!affordableAction) reasonCodes.push('insufficient_budget');

  // ---- and only then, the economics ----------------------------------------

  const tokenScale = state.resources.totalTokenBudget > 0
    ? state.resources.totalTokenBudget
    : NOMINAL_TOKEN_SCALE;
  const latencyScale = state.resources.latencyBudgetMs && state.resources.latencyBudgetMs > 0
    ? state.resources.latencyBudgetMs
    : NOMINAL_LATENCY_BUDGET_MS;

  const tokenBenefit = candidate.expectedTokenBenefit / tokenScale;
  // Orchestration overhead is charged here rather than tracked separately
  // because an optimizer whose own cost is accounted somewhere it never reads
  // will always look profitable.
  const tokenCost = (candidate.tokenCost + candidate.coordinationCost + candidate.orchestrationCost) / tokenScale;
  const latencyBenefit = candidate.expectedLatencyBenefit / latencyScale;
  const latencyCost = candidate.latencyCost / latencyScale;

  const expectedBenefit =
    weights.tokens * tokenBenefit
    + weights.quality * candidate.expectedQualityBenefit
    + weights.latency * latencyBenefit;
  const expectedCost =
    weights.tokens * tokenCost
    + weights.quality * candidate.qualityRisk
    + weights.latency * latencyCost;

  // Two independent reasons the expected effect might not materialize: we may
  // be wrong about the numbers (confidence), or the action may simply not work
  // (failureRisk). Multiplied because they compound, and applied to the *net*
  // so that being unsure about a loss moves it towards zero rather than past it.
  const discount = candidate.confidence * (1 - candidate.failureRisk);
  const score = finite((expectedBenefit - expectedCost) * discount);

  if (score > 0) reasonCodes.push('positive_utility');
  else if (score < 0) reasonCodes.push('negative_utility');
  else reasonCodes.push('neutral_utility');

  return {
    allowed: !hardStopped && !unsafe && !needsApproval && qualityFloorSatisfied && affordableAction,
    score,
    expectedBenefit: finite(expectedBenefit * discount),
    expectedCost: finite(expectedCost * discount),
    qualityFloorSatisfied,
    safetySatisfied: !hardStopped && !unsafe && !needsApproval,
    reasonCodes,
  };
}
