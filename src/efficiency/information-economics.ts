/** Hand it over now, or let the agent go and find it?
 *
 *  This is the one question the context planner has always been implicitly
 *  answering and never explicitly asking. The old answer was "whatever fits
 *  under the budget, best-scoring first", which is a ranking, not an economic
 *  decision — it can say a file is *relevant* and cannot say whether including
 *  it is *worth it*.
 *
 *  The asymmetry that makes the question interesting: a file handed over costs
 *  what it costs, once. The same file discovered by the agent costs several
 *  turns of searching, and **a turn is not priced like a line of context** —
 *  each one re-reads the conversation so far, which is why measured cost inside
 *  a dispatch grows superlinearly in turns rather than linearly. So a hundred
 *  tokens of context can genuinely save thousands, and the same hundred tokens
 *  spent on a file the agent was never going to need is pure waste. Both
 *  directions are real, which is why this returns a *net value* that can be
 *  negative rather than a score that can only rank.
 *
 *  Three things make the arithmetic honest:
 *
 *   - **Rediscovery is probabilistic.** It is what the agent would spend
 *     *given that it needs the file*, weighted by how likely that is. A
 *     candidate the goal named outright has a rediscovery cost near zero: the
 *     agent was going to open it first anyway.
 *   - **Quality risk is priced in tokens.** Under a 2:2:1 objective tokens and
 *     quality carry equal weight, so one unit of quality is worth one budget of
 *     tokens. That is not a fudge factor — it is what the approved objective
 *     *means*, written down where it can be checked.
 *   - **The optimizer charges itself.** Evaluating a candidate costs something,
 *     and it is subtracted here. An optimizer whose own cost is accounted
 *     somewhere it never reads will always look profitable.
 *
 *  Deterministic and total: no model, no clock, no I/O. */
import { clamp01 } from './policy-types.js';
import { explorationAvoided } from '../context/scoring.js';
import { artifactRole, type ContextCandidate } from '../context/candidates.js';
import type { EconomicState } from '../decision/state.js';
import { DEFAULT_UTILITY_WEIGHTS, type UtilityWeights } from '../decision/utility.js';

export interface InformationEconomics {
  /** Tokens to provide it now, including what deciding to cost. */
  acquisitionCost: number;
  /** Tokens the agent is expected to spend finding it itself, weighted by how
   *  likely it is to need it at all. */
  expectedRediscoveryCost: number;
  /** [0,1]. How much less likely the result is to be wrong for having it. */
  expectedQualityRiskReduction: number;
  /** Milliseconds saved by not searching. */
  expectedLatencyReduction: number;
  /** Everything above, in tokens, net. Negative means including it costs more
   *  than leaving it out. */
  expectedNetValue: number;
  confidence: number;
}

/** How expensive self-discovery actually is.
 *
 *  Both numbers are claims about this runtime, not universal constants, and
 *  both are deliberately conservative — overstating them would make the planner
 *  include everything, which is the behaviour this subsystem exists to stop.
 *
 *  `turnsToRediscover` is 3: the measured shape of an agent finding a
 *  structural neighbour it was not handed is a grep, a read, and a second read
 *  to confirm. `tokensPerExploratoryTurn` is 2,000, which is the *marginal*
 *  cost of one such turn — the tool call, its output, and the model's reply.
 *  The conversation prefix is re-read on every turn too and costs far more, but
 *  it is largely served from the provider's cache, and pricing it at full rate
 *  would let this model justify any amount of context.
 *
 *  Configurable because the benchmark, not this comment, should settle them. */
export interface DiscoveryModel {
  turnsToRediscover: number;
  tokensPerExploratoryTurn: number;
  msPerExploratoryTurn: number;
  /** What evaluating one candidate costs the optimizer. Small and non-zero: an
   *  optimization step that claims to be free is one nobody can hold to
   *  account. */
  evaluationCost: number;
}

export const DEFAULT_DISCOVERY_MODEL: DiscoveryModel = {
  turnsToRediscover: 3,
  tokensPerExploratoryTurn: 2_000,
  msPerExploratoryTurn: 8_000,
  evaluationCost: 2,
};

/** The token scale used when a task carries no budget of its own. Matches
 *  `decision/utility.ts` — one nominal scale, not two. */
const NOMINAL_TOKEN_SCALE = 10_000;
const NOMINAL_LATENCY_BUDGET_MS = 600_000;

/** How much having this artifact lowers the chance of getting the work wrong.
 *
 *  Generic on both sides, like `taskFitScore`: it is about what *kind* of
 *  artifact this is against what *kind* of doubt the run has, never about which
 *  file it is. The test that covers a file being changed is the strongest case
 *  there is — work that changes code changes its test, and an agent that never
 *  saw the test writes a change that breaks it. */
function qualityRiskReduction(candidate: ContextCandidate, state: EconomicState): number {
  const needed = explorationAvoided(candidate);
  const role = artifactRole(candidate.path);
  const covers = candidate.relationships.some((r) => r.startsWith('test-of:') || r.startsWith('tested-by:'));

  // Which doubt this artifact speaks to. A test speaks to whether the result is
  // correct; source and config speak to where and how things work.
  const doubt = role === 'test' || covers
    ? Math.max(state.uncertainty.validation, state.uncertainty.behavioral)
    : state.uncertainty.structural;

  return clamp01(needed * doubt * candidate.confidenceScore);
}

export function evaluateInformationOpportunity(input: {
  candidate: ContextCandidate;
  state: EconomicState;
  model?: DiscoveryModel;
  weights?: UtilityWeights;
}): InformationEconomics {
  const { candidate, state } = input;
  const model = input.model ?? DEFAULT_DISCOVERY_MODEL;
  const weights = input.weights ?? DEFAULT_UTILITY_WEIGHTS;

  const tokenScale = state.resources.totalTokenBudget > 0
    ? state.resources.totalTokenBudget
    : NOMINAL_TOKEN_SCALE;
  const latencyScale = state.resources.latencyBudgetMs && state.resources.latencyBudgetMs > 0
    ? state.resources.latencyBudgetMs
    : NOMINAL_LATENCY_BUDGET_MS;

  // How likely the agent is to need this at all, and therefore how much of the
  // rediscovery cost is really on offer. Reuses the selector's own term rather
  // than inventing a second one: two answers to "would the agent have had to
  // find this?" would drift, and the receipt would stop explaining the
  // selection.
  const needed = explorationAvoided(candidate);

  const acquisitionCost = Math.max(0, candidate.estimatedTokens) + Math.max(0, model.evaluationCost);
  const expectedRediscoveryCost = needed * model.turnsToRediscover * model.tokensPerExploratoryTurn;
  const expectedQualityRiskReduction = qualityRiskReduction(candidate, state);
  const expectedLatencyReduction = needed * model.turnsToRediscover * model.msPerExploratoryTurn;

  // Quality and latency, converted into tokens at the objective's own exchange
  // rate. Under 2:2:1 a unit of quality is worth a whole budget of tokens and a
  // whole latency budget is worth half of one — which is exactly what giving
  // tokens and quality equal weight, and latency half, *says*. Writing the
  // conversion down here is what makes it checkable instead of implicit.
  const qualityInTokens = weights.tokens <= 0
    ? 0
    : expectedQualityRiskReduction * (weights.quality / weights.tokens) * tokenScale;
  const latencyInTokens = weights.tokens <= 0
    ? 0
    : (expectedLatencyReduction / latencyScale) * (weights.latency / weights.tokens) * tokenScale;

  return {
    acquisitionCost,
    expectedRediscoveryCost,
    expectedQualityRiskReduction,
    expectedLatencyReduction,
    expectedNetValue: expectedRediscoveryCost + qualityInTokens + latencyInTokens - acquisitionCost,
    // The candidate's own evidence, capped by how much the orchestrator trusts
    // its reading of the run. Doubt reduces pressure to act, never raises it.
    confidence: clamp01(candidate.confidenceScore * state.trajectory.orchestrationConfidence),
  };
}
