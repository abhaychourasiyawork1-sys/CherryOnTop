/** Is this action allowed at all, and what does finishing the task cost if we
 *  take it?
 *
 *  Two questions, answered in that order and reported separately. **Hard
 *  constraints are evaluated before any cost and cannot be bought by one.** A
 *  constraint a cheap enough number can overturn is not a constraint, it is a
 *  weight — and the failure mode of economic optimization is precisely that
 *  quality and safety get quietly re-priced as weights and traded for tokens.
 *
 *  The objective is no longer a weighted score (`tokens 0.4 : quality 0.4 :
 *  latency 0.2`). It is the one the runtime is actually trying to minimize:
 *
 *      Q(s, a) = C_now(a) + E[ V(s') | s, a ]
 *
 *  where V(s) is the expected cost of finishing the task from state s. Quality
 *  is not a term in Q; it is a floor, checked against a *conservative* success
 *  estimate. Latency is a constraint when the task has a latency budget.
 *
 *  Three consequences worth stating, because each fixes a way the weighted
 *  score went wrong:
 *
 *   - **`continue` is not free.** Its immediate cost is zero, but its Q is V(s):
 *     everything the current trajectory is still expected to spend, including
 *     the expected cost of recovering from where it is heading. An intervention
 *     that costs something now can therefore beat it.
 *   - **`stop` is terminal**, not cheap. It is only feasible when the task is
 *     validated complete or nothing else is permitted.
 *   - **Doubt shrinks claimed savings, never invents them.** Confidence widens
 *     the cost bound the market ranks on; it does not multiply a score.
 *
 *  Deterministic and total: no model, no clock, no I/O. This runs on the hot
 *  path of the thing being optimized. */
import { clamp01 } from '../efficiency/policy-types.js';
import { normalizeActionCandidate, type ActionCandidate } from './actions.js';
import type { EconomicState } from './state.js';
import { availableTokens, type ActionTransitionEstimate } from './transition.js';
import { assessDecisionTrust } from './trust.js';

// ---------------------------------------------------------------------------
// Prices and scales. Each is a unit conversion or a normalizer, never a gate.
// ---------------------------------------------------------------------------

/** What a token costs when the task did not say. Sonnet-class input pricing
 *  ($3/M): a token of agent work is mostly input and cache, and an unknown
 *  price must not read as free. */
export const DEFAULT_USD_PER_TOKEN = 3 / 1_000_000;

/** The token scale assumed when a task has no budget at all. A divisor that
 *  keeps the remaining-work estimate non-zero, not a bound on anything. */
const NOMINAL_TOKEN_SCALE = 10_000;

/** Without a measured task size, a task is assumed to need half its budget.
 *  The budget is a ceiling set with headroom; assuming all of it would make
 *  every saving look twice as large as it is. */
const NOMINAL_TASK_SHARE = 0.5;

/** How much of the finished work a wrong result costs to redo. Half: a retry
 *  keeps what the tombstone says is still true (`recovery/engine.ts`). */
const REWORK_SHARE = 0.5;

/** How likely an unvalidated result is to be wrong, per unit of validation
 *  doubt. Half, because doubt is not error: most unproven work is right. */
const WRONG_PER_DOUBT = 0.5;

/** How much a failed action pushes the run towards a retry. The same step the
 *  reducer applies to `failurePressure` on a failure (state.ts). */
const FAILURE_STEP = 0.25;

/** How much unresolved doubt loads the conservative remaining cost. */
const UNCERTAINTY_LOADING = 0.25;

export function usdPerToken(state: EconomicState): number {
  const price = state.resources.usdPerToken;
  return Number.isFinite(price) && (price as number) > 0 ? (price as number) : DEFAULT_USD_PER_TOKEN;
}

// ---------------------------------------------------------------------------
// V(s)
// ---------------------------------------------------------------------------

/** The dimensions of state the remaining-cost model reads. Everything else in
 *  `EconomicState` is evidence for these or a constraint on the action. */
interface ValuePoint {
  progress: number;
  failurePressure: number;
  /** Probability the result, as it stands, is wrong and will be redone. */
  wrong: number;
  /** Tokens an action has already made unnecessary. */
  credit: number;
}

/** The token scale of the whole task: measured when something measured it,
 *  else a share of the budget. Exported so the governor's risk model reads the
 *  same scale V(s) does. */
export function taskTokens(state: EconomicState): number {
  const measured = state.resources.expectedTaskTokens;
  if (Number.isFinite(measured) && (measured as number) > 0) return measured as number;
  const total = state.resources.totalTokenBudget;
  return total > 0 ? total * NOMINAL_TASK_SHARE : NOMINAL_TOKEN_SCALE;
}

/** Validated completion: the only state from which finishing costs nothing. */
export function taskComplete(state: EconomicState): boolean {
  return state.validation.status === 'passed';
}

function pointOf(state: EconomicState): ValuePoint {
  const wrong = taskComplete(state) || !state.validation.required
    ? 0
    : clamp01(state.uncertainty.validation * WRONG_PER_DOUBT);
  return {
    progress: state.trajectory.progress,
    failurePressure: state.trajectory.failurePressure,
    wrong,
    credit: 0,
  };
}

/** Expected tokens to finish from a point: the work left, plus the chance the
 *  run must recover or redo times what that costs. */
function valueAt(point: ValuePoint, work: number): number {
  const remaining = Math.max(0, (1 - clamp01(point.progress)) * work - point.credit);
  const failing = clamp01(point.failurePressure);
  const redo = 1 - (1 - failing) * (1 - clamp01(point.wrong));
  const recovery = remaining + REWORK_SHARE * clamp01(point.progress) * work;
  return remaining + redo * recovery;
}

/** V(s): expected cost to finish from this state, in tokens and dollars. Zero
 *  for a validated-complete task. */
export function stateValue(state: EconomicState): { tokens: number; usd: number } {
  if (taskComplete(state)) return { tokens: 0, usd: 0 };
  const tokens = valueAt(pointOf(state), taskTokens(state));
  return { tokens, usd: tokens * usdPerToken(state) };
}

/** Tokens of work left on the current trajectory: what a failed attempt at
 *  the whole remaining goal has to redo. */
export function remainingWorkTokens(state: EconomicState): number {
  return taskComplete(state) ? 0 : (1 - clamp01(state.trajectory.progress)) * taskTokens(state);
}

/** What a unit drop in the probability the result is wrong is worth, in
 *  tokens: the rework it would have cost. The exchange rate every other module
 *  that prices correctness must use, so context selection and the market
 *  cannot disagree about what quality is worth. */
export function reworkCostTokens(state: EconomicState): number {
  const work = taskTokens(state);
  const progress = clamp01(state.trajectory.progress);
  return (1 - progress) * work + REWORK_SHARE * progress * work;
}

/** Probability the result, as it stands, is wrong and will be redone — the
 *  `wrong` term of V(s). Exported so the risk model starts from the same
 *  number rather than a second answer to it. */
export function wrongProbability(state: EconomicState): number {
  return pointOf(state).wrong;
}

/** The redo probability V(s) charges recovery at: failing, or wrong. */
export function redoProbability(state: EconomicState): number {
  const point = pointOf(state);
  return 1 - (1 - clamp01(point.failurePressure)) * (1 - clamp01(point.wrong));
}

export { WRONG_PER_DOUBT, UNCERTAINTY_LOADING, FAILURE_STEP };

export function meanUncertainty(state: EconomicState): number {
  const u = state.uncertainty;
  return (u.target + u.structural + u.behavioral + u.validation) / 4;
}

// ---------------------------------------------------------------------------
// Estimation levels the market owns: deterministic and signal-derived.
// ---------------------------------------------------------------------------

/** Level 0: questions with a known answer. Zero model, zero lookup. */
export function deterministicEstimate(action: ActionCandidate, state: EconomicState): ActionTransitionEstimate | null {
  const candidate = normalizeActionCandidate(action);
  const terminal = (lowerBound: number, tokens: number): ActionTransitionEstimate => {
    const usd = tokens * usdPerToken(state);
    return {
      actionId: candidate.id,
      immediateCost: { tokens, usd, latencyMs: candidate.latencyCost },
      outcomes: [{ probability: 1, completed: true, succeeded: true, nextStateDelta: { progress: 1 } }],
      expectedRemainingCost: { tokens: 0, usd: 0, latencyMs: 0 },
      bounds: { successLowerBound: lowerBound, costUpperBoundUsd: usd },
      confidence: 1,
      provenance: 'deterministic',
      evidenceIds: [],
    };
  };

  // Stopping a validated task costs nothing and finishes it.
  if (candidate.kind === 'stop' && taskComplete(state)) return terminal(1, 0);

  // An exact, still-valid answer to this question. The market still has to
  // choose it — but pricing it needs nothing more than its own cost.
  if (candidate.metadata.exactReuse === true) {
    return terminal(clamp01(1 - candidate.qualityRisk), candidate.tokenCost);
  }
  return null;
}

/** The last level of the funnel: the candidate's own effect signals, read as
 *  a one-step transition. The fields of `ActionCandidate` are what an action
 *  is expected to *do*; this turns them into what finishing then costs.
 *
 *   - progress closes a share of the remaining work, and relieves failure
 *     pressure in the same proportion (a run making progress is not failing);
 *   - `expectedTokenBenefit` is work the action makes unnecessary;
 *   - quality benefit and risk move the chance the result is wrong;
 *   - `failureRisk` is the chance none of that happens and the run is pushed
 *     one step further towards a retry. */
export function signalEstimate(action: ActionCandidate, state: EconomicState): ActionTransitionEstimate {
  const candidate = normalizeActionCandidate(action);
  const price = usdPerToken(state);
  const work = taskTokens(state);
  const here = pointOf(state);
  const current = stateValue(state).tokens;

  const succeeded = 1 - candidate.failureRisk;
  const success: ValuePoint = {
    progress: here.progress + candidate.expectedProgress * (1 - here.progress),
    failurePressure: here.failurePressure * (1 - candidate.expectedProgress),
    wrong: clamp01(here.wrong - candidate.expectedQualityBenefit + candidate.qualityRisk),
    credit: candidate.expectedTokenBenefit,
  };
  const failure: ValuePoint = { ...here, failurePressure: clamp01(here.failurePressure + FAILURE_STEP) };

  const complete = taskComplete(state);
  const successValue = complete ? 0 : valueAt(success, work);
  const failureValue = complete ? 0 : valueAt(failure, work);
  const remaining = succeeded * successValue + (1 - succeeded) * failureValue;

  const immediate = candidate.tokenCost + candidate.coordinationCost + candidate.orchestrationCost;

  // How far to believe the claimed saving. The action's own confidence, and
  // the orchestrator's trust in its reading of the run: an uncertain
  // orchestrator must intervene *less*, so its doubt discounts every saving it
  // claims. The cost side is never discounted — being unsure about a loss does
  // not make it smaller.
  const trust = assessDecisionTrust({ state, action: candidate });
  const believed = Math.min(candidate.confidence, 1 - trust.risk);
  const claimedSaving = Math.max(0, current - remaining);
  // The run's own doubt loads what is left to do, the same for every action.
  // Information gain is deliberately *not* a lever here: providers already
  // price what an answer is worth as the rediscovery it avoids
  // (`expectedTokenBenefit`), and letting the same information also shrink the
  // band would buy it twice. It is recorded on the transition instead.
  const upperTokens = immediate + remaining
    + (1 - believed) * claimedSaving
    + UNCERTAINTY_LOADING * meanUncertainty(state) * remaining;

  // The result's quality if this is taken: measured from a clean 1 rather than
  // from the run's current doubt, because the floor is about what the action
  // does to the result. Lowered by the action's own doubt about its effect.
  const quality = clamp01(1 - candidate.qualityRisk + candidate.expectedQualityBenefit);
  const lowerBound = clamp01(quality - (1 - candidate.confidence) * Math.sqrt(quality * (1 - quality)));

  return {
    actionId: candidate.id,
    immediateCost: { tokens: immediate, usd: immediate * price, latencyMs: candidate.latencyCost },
    outcomes: [
      {
        probability: succeeded, completed: false, succeeded: true,
        nextStateDelta: {
          progress: success.progress - here.progress,
          informationGain: candidate.expectedInformationGain,
          failurePressure: success.failurePressure - here.failurePressure,
        },
      },
      ...(succeeded < 1 ? [{
        probability: 1 - succeeded, completed: false, succeeded: false,
        nextStateDelta: { failurePressure: failure.failurePressure - here.failurePressure },
      }] : []),
    ],
    expectedRemainingCost: { tokens: remaining, usd: remaining * price, latencyMs: 0 },
    bounds: { successLowerBound: lowerBound, costUpperBoundUsd: upperTokens * price },
    confidence: believed,
    provenance: 'signal',
    evidenceIds: [],
  };
}

// ---------------------------------------------------------------------------
// Hard constraints, then cost-to-go.
// ---------------------------------------------------------------------------

/** A reason the runtime cannot trust its own reading of the run. Present, it
 *  makes every *intervention* infeasible — the null action stays available,
 *  because not optimizing is always safe. Safety is not a fault: it is a hard
 *  constraint on the action itself, and refusing the action is its answer. */
export type DecisionFault =
  | 'missing_telemetry'
  | 'stale_repository_graph'
  | 'invalid_memory'
  | 'decision_engine_error'
  | 'evidence_mechanism_error';

export interface ActionEvaluation {
  /** False when any hard constraint fired. Independent of cost: an action can
   *  be both cheap and forbidden, and collapsing the two would hide exactly the
   *  case worth seeing. */
  allowed: boolean;
  estimate: ActionTransitionEstimate;
  /** Q(s,a) in dollars: immediate cost plus expected cost to finish. */
  expectedCostUsd: number;
  /** The upper bound the market ranks on. */
  conservativeCostUsd: number;
  successLowerBound: number;
  /** V(s) − Q(s,a): what this is expected to save over the current trajectory.
   *  Positive means worth taking over doing nothing. */
  advantageUsd: number;
  qualityFloorSatisfied: boolean;
  safetySatisfied: boolean;
  /** Machine-readable and stable — what a benchmark attributes a regression
   *  with. */
  reasonCodes: string[];
}

/** Reason codes that describe an evaluation rather than refuse it. Everything
 *  else a hard constraint or the quality floor put there. */
const INFORMATIONAL = new Set(['saves_cost', 'adds_cost', 'cost_neutral', 'learning_value']);

export function isConstraintCode(code: string): boolean {
  return !INFORMATIONAL.has(code);
}

/** Actions that do nothing in the world. Interventions are everything else. */
export function isNullAction(candidate: ActionCandidate): boolean {
  return candidate.kind === 'continue' || candidate.kind === 'stop';
}

/** What an action may claim from the token budget without eating the recovery
 *  reserve. Recovery may spend the reserve; that is what it is held for. */
function affordableTokens(state: EconomicState, candidate: ActionCandidate): number {
  const reserve = candidate.kind === 'recover' ? 0 : state.resources.recoveryReserve;
  return Math.max(0, availableTokens(state) - reserve);
}

function affordableUsd(state: EconomicState): number {
  const r = state.resources;
  if (!r.budgetUsd || r.budgetUsd <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, r.budgetUsd - (r.spentUsd ?? 0) - (r.reservedUsd ?? 0));
}

/** The rules that outrank every cost. Run before anything is estimated. */
export function hardConstraints(
  action: ActionCandidate,
  state: EconomicState,
  faults: readonly DecisionFault[] = [],
): { allowed: boolean; safetySatisfied: boolean; reasonCodes: string[] } {
  const candidate = normalizeActionCandidate(action);
  const codes: string[] = [];

  if (state.constraints.hardStop && candidate.kind !== 'stop') codes.push('hard_stop');
  if (candidate.metadata.unsafe === true) codes.push('safety_violation');
  if (candidate.metadata.requiresApproval === true) codes.push('requires_approval');
  // An unavailable capability is a fact about the world, not a price. A
  // provider outage or a harness that cannot serve the model lands here.
  if (typeof candidate.metadata.infeasible === 'string') codes.push(`unavailable:${candidate.metadata.infeasible}`);

  // Stop is terminal. Feasible when the work is validated, or when the run is
  // under a hard stop and nothing else may happen — never merely because it
  // is cheap.
  if (candidate.kind === 'stop' && !taskComplete(state) && !state.constraints.hardStop) {
    codes.push('stop_not_terminal');
  }

  const spend = candidate.tokenCost + candidate.coordinationCost;
  if (spend > 0 && spend > affordableTokens(state, candidate)) codes.push('insufficient_budget');

  if (!isNullAction(candidate)) {
    for (const fault of faults) codes.push(`fault:${fault}`);
    const optimizationLeft = state.resources.optimizationTokens - state.resources.optimizationConsumedTokens;
    if (candidate.orchestrationCost > 0 && candidate.orchestrationCost > optimizationLeft) {
      codes.push('optimization_budget_exhausted');
    }
  }

  const latencyBudget = state.resources.latencyBudgetMs;
  if (latencyBudget !== undefined && candidate.latencyCost - candidate.expectedLatencyBenefit > latencyBudget) {
    codes.push('latency_budget');
  }

  const safetySatisfied = !codes.some((c) => c === 'hard_stop' || c === 'safety_violation' || c === 'requires_approval');
  return { allowed: codes.length === 0, safetySatisfied, reasonCodes: codes };
}

/** Prices one action against one state, given its transition estimate (the
 *  signal-derived one when the caller has none). The market calls this for
 *  every candidate; nothing else ranks. */
export function evaluateAction(
  action: ActionCandidate,
  state: EconomicState,
  options: {
    estimate?: ActionTransitionEstimate;
    faults?: readonly DecisionFault[];
    /** V(s) under the model that produced `estimate`, when that is not this
     *  module's own (see `valuation` in engine.ts). Advantage is only
     *  meaningful against the same model's V(s). */
    baselineValueUsd?: number;
  } = {},
): ActionEvaluation {
  const candidate = normalizeActionCandidate(action);
  const gates = hardConstraints(candidate, state, options.faults);
  const estimate = options.estimate ?? deterministicEstimate(candidate, state) ?? signalEstimate(candidate, state);
  const codes = [...gates.reasonCodes];

  // Dollars are checked against the estimate, since only it knows the price of
  // this particular action on this particular model.
  if (estimate.immediateCost.usd > affordableUsd(state) && estimate.immediateCost.usd > 0) {
    codes.push('insufficient_budget_usd');
  }

  const successLowerBound = clamp01(estimate.bounds.successLowerBound);
  const qualityFloorSatisfied = successLowerBound >= state.constraints.qualityFloor;
  if (!qualityFloorSatisfied) codes.push('quality_floor');

  const expectedCostUsd = estimate.immediateCost.usd + estimate.expectedRemainingCost.usd;
  // What taking this action would *teach*, in dollars of future decisions it
  // could make cheaper (a provider's estimate — see `learningValueOf` in
  // execution-market.ts). Information is a real return, so it lowers the cost
  // the market ranks on; it never touches the quality floor, so nothing unsafe
  // is ever tried to find out. Zero once the evidence is in.
  const learningValueUsd = Number.isFinite(candidate.metadata.learningValueUsd)
    ? Math.max(0, candidate.metadata.learningValueUsd as number) : 0;
  const conservativeCostUsd = Math.max(expectedCostUsd, estimate.bounds.costUpperBoundUsd) - learningValueUsd;
  const baseline = Number.isFinite(options.baselineValueUsd) ? options.baselineValueUsd as number : stateValue(state).usd;
  const advantageUsd = baseline - expectedCostUsd;
  codes.push(advantageUsd > 1e-12 ? 'saves_cost' : advantageUsd < -1e-12 ? 'adds_cost' : 'cost_neutral');
  if (learningValueUsd > 0) codes.push('learning_value');

  return {
    allowed: !codes.some(isConstraintCode),
    estimate,
    expectedCostUsd,
    conservativeCostUsd,
    successLowerBound,
    advantageUsd,
    qualityFloorSatisfied,
    safetySatisfied: gates.safetySatisfied,
    reasonCodes: codes,
  };
}
