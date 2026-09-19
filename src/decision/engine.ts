/** The one contract every choice in the runtime is expressed through.
 *
 *  Emphatically **not** a new brain. Every number here comes from the module
 *  that already owned it — `decideExecution` for delegation economics,
 *  `routeModel` for model tiers, `decideIntegration` for synthesis,
 *  `planEvidence` for evidence. Reimplementing any of that arithmetic here
 *  would create a second answer to a question that already has one, and the two
 *  would drift.
 *
 *  What this adds is the part none of them had: a common order of operations.
 *
 *   1. **Hard gates first.** Authority, budget and safety are rules, not terms.
 *      A decision that can be bought by a good enough score is not a boundary.
 *   2. **Free things next.** If the answer is already held, nothing needs
 *      scoring — and scoring it anyway is a cost paid to discover there was no
 *      cost.
 *   3. **Economics last**, and always against a named alternative.
 */
import { randomUUID } from 'node:crypto';
import { decideExecution, type DecideExecutionInput, type DecideExecutionResult } from '../engines/decide-execution.js';
import { routeModel, type ModelRouteInput } from '../intelligence/model-router.js';
import { decideIntegration } from '../intelligence/integrate-results.js';
import { planEvidence, type EvidenceCandidate } from '../execution/evidence-planner.js';
import { isClosed, type KnowledgeFrontier } from '../context/frontier.js';
import type { ChildReport } from '../intelligence/synthesize.js';
import type { Authority } from '../schemas/node-contract.js';
import {
  receipt, FREE, type DecisionReceipt, type DecisionAlternative, type DecisionEstimate,
} from './types.js';

export * from './types.js';

/** What a dispatch is expected to cost, from the ledger rather than a guess.
 *  Passed in so the engine never reaches for a database. */
export interface DispatchEstimate extends DecisionEstimate {}

export interface SafetyInput {
  authority: Authority;
  spentUsd: number;
  /** Set when a person must approve before anything happens. */
  requiresApproval?: boolean;
}

/** The rules that outrank every score. Returns a receipt when one fires, and
 *  null when the decision is still open. */
export function hardGates(input: SafetyInput): DecisionReceipt | null {
  if (input.requiresApproval) {
    return receipt({
      chosen: 'WAIT', gate: 'approval', fastPath: true,
      reason: 'a person has to approve this before anything is spent',
    });
  }
  // Zero means nobody costed this node, which is not the same as out of money —
  // the convention model-router.ts already uses.
  if (input.authority.budget_usd > 0 && input.spentUsd >= input.authority.budget_usd) {
    return receipt({
      chosen: 'STOP', gate: 'budget', fastPath: true,
      reason: `budget spent — $${input.spentUsd.toFixed(2)} of $${input.authority.budget_usd.toFixed(2)}`,
    });
  }
  return null;
}

export interface ExecutionPathInput extends SafetyInput, DecideExecutionInput {
  /** A prior answer to this exact question that is still valid. */
  reusable?: { tokens: number; costUsd: number };
  /** What a fresh dispatch would cost. */
  dispatch: DispatchEstimate;
  /** Outstanding questions. A closed frontier means the work is already done. */
  frontier?: KnowledgeFrontier;
  /** How many children a fan-out would actually create. Absent means "as many
   *  as this node's authority allows", which is the number the planner is
   *  handed as its ceiling. */
  plannedChildCount?: number;
}

/** What a fan-out costs, as a function of how wide it is.
 *
 *  A flat "×2" was the old answer, and it was wrong in both directions: it
 *  priced a four-way split as a two-way one, and it charged the same for a
 *  two-way split whatever the node's allowance was. Three terms, all of them
 *  real dispatches somebody pays for:
 *
 *   - the planning run that produces the subgoals,
 *   - k children,
 *   - the synthesis run that combines their answers.
 *
 *  Latency is *not* k times a dispatch: children run concurrently, so the wall
 *  clock is plan + one child + synthesis. Summing children there is the mistake
 *  that makes every fan-out look slower than it is. */
export function delegationEstimate(dispatch: DispatchEstimate, childCount: number): DispatchEstimate {
  const children = Math.max(1, Math.floor(childCount));
  const dispatches = children + 2;
  return {
    tokens: dispatch.tokens * dispatches,
    // plan -> (children, in parallel) -> synthesize.
    latencyMs: dispatch.latencyMs * 3,
    costUsd: dispatch.costUsd * dispatches,
  };
}

/** How wide the fan-out would be: what the caller planned, else what this
 *  node's agent allowance permits. Clamped at one, because a delegation that
 *  creates no children is not a delegation. */
function plannedChildren(input: ExecutionPathInput): number {
  return Math.max(1, Math.floor(input.plannedChildCount ?? input.authority.max_child_count ?? 1));
}

/** Reuse, spawn, run, wait or stop — the top-level shape of a node's work. */
export function decideExecutionPath(input: ExecutionPathInput): DecisionReceipt {
  const gated = hardGates(input);
  if (gated) return gated;

  const dispatchAlternative: DecisionAlternative = {
    type: 'RUN_MODEL',
    reason: 'do the work in a fresh sandbox',
    estimate: input.dispatch,
  };

  // Free things before scored things. An exact result already in hand cannot be
  // beaten by anything a comparison could find, so running the comparison is a
  // cost paid to discover there was no cost.
  if (input.reusable) {
    return receipt({
      chosen: 'REUSE_COMPUTATION',
      fastPath: true,
      reason: `this exact question already has a valid answer, saving ~${input.reusable.tokens} tokens`,
      estimate: FREE,
      alternatives: [dispatchAlternative],
    });
  }

  if (input.frontier && isClosed(input.frontier) && input.frontier.known.length > 0) {
    return receipt({
      chosen: 'STOP',
      fastPath: true,
      reason: 'the evidence already held closes every outstanding question',
      estimate: FREE,
      alternatives: [dispatchAlternative],
    });
  }

  // Everything below is the existing economics, unchanged — this only puts its
  // answer in the common shape.
  const decision = decideExecution(input);
  const score = decision.breakdown.score ?? 0;
  const threshold = decision.breakdown.threshold ?? 0;
  // Margin as confidence: a decision that cleared the line by a hair is one a
  // reader should treat as a coin toss, and the breakdown is the only place
  // that fact exists.
  const confidence = Math.min(1, 0.5 + Math.abs(score - threshold));

  if (decision.outcome === 'ESCALATE') {
    return receipt({
      chosen: 'WAIT', gate: 'budget-floor', fastPath: false, confidence,
      reason: 'splitting this needs more budget than the node holds',
      estimate: FREE,
      alternatives: [dispatchAlternative],
    });
  }

  if (decision.outcome === 'DELEGATE') {
    return receipt({
      chosen: 'SPAWN_AGENT', confidence,
      reason: `the goal comes apart and delegation scores ${score.toFixed(2)} against ${threshold}`,
      estimate: delegationEstimate(input.dispatch, plannedChildren(input)),
      alternatives: [dispatchAlternative],
    });
  }

  return receipt({
    chosen: 'RUN_MODEL', confidence,
    reason: decision.breakdown.reason_single_unit_of_work
      ? 'this is one unit of work, so splitting it would buy a planner to be told so'
      : `delegation scores ${score.toFixed(2)} against ${threshold}`,
    estimate: input.dispatch,
    alternatives: [{
      type: 'SPAWN_AGENT',
      reason: 'split the goal across agents',
      estimate: delegationEstimate(input.dispatch, plannedChildren(input)),
    }],
  });
}

export interface EvidenceInput extends SafetyInput {
  frontier: KnowledgeFrontier;
  candidates: EvidenceCandidate[];
}

/** How to close the next gap: reuse, expand, a tool, a test, or a model. */
const EVIDENCE_TO_DECISION: Record<EvidenceCandidate['action'], DecisionReceipt['chosen']> = {
  reuse: 'REUSE_CONTEXT',
  expand: 'EXPAND_CONTEXT',
  search: 'RUN_TOOL',
  read_symbol: 'EXPAND_CONTEXT',
  run_test: 'RUN_TEST',
  run_model: 'RUN_MODEL',
  spawn_agent: 'SPAWN_AGENT',
};

export function decideEvidence(input: EvidenceInput): DecisionReceipt {
  const gated = hardGates(input);
  if (gated) return gated;

  const plan = planEvidence(input.frontier, input.candidates);
  const alternatives: DecisionAlternative[] = plan.ranked
    .filter((entry) => entry.candidate !== plan.chosen)
    .map((entry) => ({
      type: EVIDENCE_TO_DECISION[entry.candidate.action],
      reason: entry.candidate.reason,
      estimate: { tokens: entry.candidate.estimatedTokens, latencyMs: entry.candidate.estimatedLatencyMs, costUsd: 0 },
    }));

  if (!plan.chosen) {
    return receipt({ chosen: 'STOP', reason: plan.reason, estimate: FREE, alternatives, fastPath: true });
  }

  return receipt({
    chosen: EVIDENCE_TO_DECISION[plan.chosen.action],
    reason: plan.reason,
    confidence: plan.chosen.expectedGain,
    estimate: { tokens: plan.chosen.estimatedTokens, latencyMs: plan.chosen.estimatedLatencyMs, costUsd: 0 },
    alternatives,
    fastPath: plan.chosen.action === 'reuse',
  });
}

export interface IntegrationInput extends SafetyInput {
  children: ChildReport[];
  synthesis: DispatchEstimate;
}

/** Whether combining the children's answers needs a model. */
export function decideSynthesis(input: IntegrationInput): DecisionReceipt {
  const gated = hardGates(input);
  if (gated) return gated;

  const decision = decideIntegration(input.children);
  const synthesisAlternative: DecisionAlternative = {
    type: 'SYNTHESIZE', reason: 'pay a model to merge the reports', estimate: input.synthesis,
  };

  if (decision.kind === 'synthesize') {
    return receipt({
      chosen: 'SYNTHESIZE', reason: decision.reason, estimate: input.synthesis,
      alternatives: [{ type: 'STOP', reason: 'merge the reports mechanically', estimate: FREE }],
    });
  }

  return receipt({
    chosen: 'STOP', fastPath: true,
    reason: decision.kind === 'nothing'
      ? 'no child reported anything to combine'
      : decision.kind === 'return_child'
        ? 'one agent answered this; its answer is the answer'
        : 'the reports merge mechanically, so no model is needed',
    estimate: FREE,
    alternatives: [synthesisAlternative],
  });
}

/** `budgetUsd` and `spentUsd` are deliberately *not* repeated here: the gate
 *  already has them, and two fields meaning the same money is how a guard and a
 *  router come to disagree about whether a node can afford anything. */
export interface ModelInput extends SafetyInput, Omit<ModelRouteInput, 'budgetUsd' | 'spentUsd'> {
  dispatch: DispatchEstimate;
}

/** Which model tier runs this dispatch. */
export function decideModel(input: ModelInput): DecisionReceipt {
  const gated = hardGates(input);
  if (gated) return gated;

  const route = routeModel({ ...input, budgetUsd: input.authority.budget_usd, spentUsd: input.spentUsd });
  return receipt({
    chosen: route.tier === 'deep' ? 'ESCALATE_MODEL' : 'RUN_MODEL',
    reason: route.reason,
    estimate: input.dispatch,
    alternatives: [{
      type: 'RUN_MODEL',
      reason: 'the runtime default model',
      estimate: input.dispatch,
    }],
    fastPath: route.tier === 'fast',
  });
}

// ---------------------------------------------------------------------------
// The state/action evaluator.
//
// Everything above answers one specific question each — which model, which
// evidence, whether to split — in its own vocabulary. This answers the general
// one: given everything the runtime currently knows, and everything it could
// currently do, what is worth doing?
//
// It is emphatically not a second brain either. It contains no economics of its
// own: `evaluateActionUtility` prices a candidate and this ranks what it
// returns. What it adds is an order of operations and a conservative default —
// the same two things `decideExecutionPath` adds to the engines it composes.
// ---------------------------------------------------------------------------

import { normalizeActionCandidate, actionCandidate, type ActionCandidate, type ActionDecision } from './actions.js';
import { clamp01 } from '../efficiency/policy-types.js';
import type { DecisionOutcome } from '../schemas/decision.js';
import { evaluateActionUtility, type UtilityWeights, type UtilityEvaluation } from './utility.js';
import { assessDecisionTrust, trustAdjusted, type TrustAssessment } from './trust.js';
import type { EconomicState } from './state.js';

/** Floating-point equality for a ranking. The same 1e-9 tolerance
 *  `engines/economics.ts` already uses for the same reason: two scores that
 *  differ in the sixteenth decimal are a tie, and treating them otherwise makes
 *  the winner depend on the order the candidates happened to arrive in. */
const TIE_EPSILON = 1e-9;

/** How many rejections a decision records. Enough to explain a surprising
 *  answer, bounded so a hundred filtered candidates cannot turn one decision
 *  into a hundred-line row. */
const MAX_RECORDED_REJECTIONS = 8;

/** Doing nothing, priced at nothing. The default answer, and deliberately a
 *  real candidate rather than a null return: a no-op that goes through the same
 *  ranking and the same receipt is a no-op somebody can audit. */
function continueAction(): ActionCandidate {
  return actionCandidate({
    id: 'continue', kind: 'continue', capability: 'agent.continue', confidence: 1,
  });
}

function stopAction(): ActionCandidate {
  return actionCandidate({ id: 'stop', kind: 'stop', capability: 'runtime.stop', confidence: 1 });
}

export interface EconomicDecisionInput {
  state: EconomicState;
  candidates: ActionCandidate[];
  weights?: UtilityWeights;
  nowMs?: number;
  /** Injected so a decision is reproducible in a test without stubbing crypto.
   *  Production never passes it. */
  decisionId?: string;
}

interface Ranked {
  candidate: ActionCandidate;
  evaluation: UtilityEvaluation;
  trust: TrustAssessment;
  /** The score actually ranked on: utility, discounted by how much the decision
   *  deserves to be believed given what it puts at stake. Equal to the raw
   *  utility for a free action, because being wrong about a free action costs
   *  nothing. */
  score: number;
}

/** The one entry point the runtime asks "what now?" through.
 *
 *  Four steps, in an order that is the design rather than an implementation
 *  detail:
 *
 *   1. Price every candidate.
 *   2. Drop the ones a hard constraint forbids — before ranking, so no score
 *      can promote a forbidden action.
 *   3. Rank what survives by utility, then confidence, then a stable id. Never
 *      by kind, and never by anything derived from what the task is *about*.
 *   4. Fall back conservatively: `continue` unless continuing is itself
 *      disallowed, and only then `stop`. The healthy action is non-intervention.
 */
export function chooseEconomicAction(input: EconomicDecisionInput): ActionDecision {
  const { state, weights } = input;
  const price = (candidate: ActionCandidate): Ranked => {
    const evaluation = evaluateActionUtility(candidate, state, weights);
    const trust = assessDecisionTrust({ state, action: candidate });
    return { candidate, evaluation, trust, score: trustAdjusted(evaluation.score, trust) };
  };

  const priced = (input.candidates ?? []).map(normalizeActionCandidate).map(price);
  const allowed = priced.filter((r) => r.evaluation.allowed);
  const rejected = priced.filter((r) => !r.evaluation.allowed);

  // Every rejection, named. A decision that cannot say what it refused and why
  // is one nobody can argue with — the same reason `DecisionReceipt` carries
  // its alternatives.
  const rejectionCodes = rejected.slice(0, MAX_RECORDED_REJECTIONS).flatMap((r) =>
    r.evaluation.reasonCodes
      .filter((code) => code.endsWith('_floor') || code.endsWith('_stop')
        || code.endsWith('_violation') || code.endsWith('_budget') || code.endsWith('_approval'))
      .map((code) => `rejected:${r.candidate.id}:${code}`));

  // Ranked once, so the tie-break tests below read the same order the winner
  // came from.
  const ranked = [...allowed].sort(compareRanked);
  const best = ranked[0];

  const decide = (
    candidate: ActionCandidate,
    evaluation: UtilityEvaluation,
    extra: string[],
  ): ActionDecision => ({
    decisionId: input.decisionId ?? randomDecisionId(),
    stateVersion: state.version,
    action: candidate,
    utility: evaluation.score,
    reasonCodes: [
      ...evaluation.reasonCodes, ...extra,
      // A decision made while the state carries a hard stop says so on its own
      // face, even when the action it chose was the one the stop permits. The
      // alternative is a receipt reading `positive_utility` on a run that was
      // already over.
      ...(state.constraints.hardStop ? ['hard_stop'] : []),
      ...rejectionCodes,
    ],
    // The orchestrator's confidence in its own reading is a ceiling on every
    // decision it makes. An uncertain orchestrator intervening harder is the
    // failure mode this whole layer exists to avoid, and a cap is the cheapest
    // possible expression of "doubt reduces pressure".
    confidence: Math.min(candidate.confidence, state.trajectory.orchestrationConfidence),
  });

  if (best && best.score > 0) {
    const extra = ['chosen_by_utility'];
    const runnerUp = ranked[1];
    if (runnerUp && Math.abs(runnerUp.score - best.score) <= TIE_EPSILON) {
      extra.push(best.candidate.confidence === runnerUp.candidate.confidence
        ? 'tie_broken_on_id'
        : 'tie_broken_on_confidence');
    }
    return decide(best.candidate, best.evaluation, [...extra, ...best.trust.reasonCodes]);
  }

  // Nothing was worth doing. The default is to let the agent get on with it —
  // and `continue` is put through the same pricing rather than assumed legal,
  // because a hard stop must be able to forbid it.
  const suppliedContinue = allowed.find((r) => r.candidate.kind === 'continue');
  const fallback = suppliedContinue ?? price(continueAction());
  if (fallback.evaluation.allowed) {
    return decide(fallback.candidate, fallback.evaluation, ['no_justified_opportunity']);
  }

  // Continuing is not permitted. Only now is stopping the answer — and stopping
  // because continuing is invalid is a different fact from stopping because a
  // score said so, so it says which.
  const stop = price(stopAction());
  return decide(stop.candidate, stop.evaluation, ['continuation_not_permitted']);
}

function compareRanked(a: Ranked, b: Ranked): number {
  // Trust-adjusted, so that as confidence falls the *expensive* options become
  // uncompetitive first. An orchestrator that intervenes harder when it knows
  // less is the failure this ordering exists to prevent.
  const byUtility = b.score - a.score;
  if (Math.abs(byUtility) > TIE_EPSILON) return byUtility;
  const byConfidence = b.candidate.confidence - a.candidate.confidence;
  if (Math.abs(byConfidence) > TIE_EPSILON) return byConfidence;
  // The last tie-break is the candidate's own stable id, never its kind and
  // never anything read off the goal: two runs over the same state must choose
  // the same action, and "whichever the producer listed first" is not that.
  return a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0;
}

function randomDecisionId(): string {
  return `dec-${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// The execution chokepoint
// ---------------------------------------------------------------------------

/** Whether to do the work or split it, authorized by the Action Market rather
 *  than by `decideExecution` alone.
 *
 *  This is the gap the architecture audit left open, and it is the one that
 *  mattered: delegation is the single most expensive thing the runtime can do,
 *  and it was the one expensive action that never passed through the common
 *  ranking. `decideExecution` scored delegation against its own threshold and
 *  the lifecycle acted on that score directly, so a fan-out could be authorized
 *  on a run that the economic state already knew was out of budget, out of
 *  quality headroom, or under a hard stop — because none of those facts were in
 *  the arithmetic that decided it.
 *
 *  What this does **not** do is re-decide delegation. `decideExecution` remains
 *  the estimate source and its verdict is honoured: if it says the goal does not
 *  come apart, no delegate candidate is offered at all. What the market adds is
 *  the veto — the budget, reserve, quality-floor and hard-stop checks every
 *  other expensive action already passed through.
 *
 *  Three gates run before the economics and cannot be bought past, because they
 *  are authority rather than value:
 *
 *   - no spawn authority, or no agent allowance — the node may not grow an
 *     organization however good the economics look;
 *   - not enough budget to fund a child *and* this node's own planning and
 *     synthesis — which is an escalation to a person, not a cheaper plan;
 *   - `decideExecution` having already concluded the goal is one unit of work.
 *
 *  Only when delegation is genuinely on the table do two candidates go to the
 *  market, and they are deliberately expressed in the same unit so they are
 *  comparable:
 *
 *   - **self** — doing k pieces of work one after another in this node's own
 *     sandbox: k dispatches of tokens, k dispatches of wall clock.
 *   - **delegate** — plan, k concurrent children, synthesize: k+2 dispatches of
 *     tokens, 3 of wall clock.
 *
 *  So delegation always costs two extra dispatches in tokens and buys k-3
 *  dispatches of wall clock. That is the real trade and the reason a two-way
 *  split almost never pays: it costs four dispatches to save nothing. The
 *  utility weights, the recovery reserve and the quality floor decide the rest,
 *  in the same arithmetic that decides everything else. */
export interface ExecutionAuthorizationInput {
  state: EconomicState;
  /** The estimate source. Its verdict gates whether a delegate candidate is
   *  offered; it does not authorize one. */
  economics: DecideExecutionResult;
  /** One dispatch, as a unit of account. Both candidates are multiples of it,
   *  so the comparison does not depend on it being a good forecast — only on it
   *  being the same for both. */
  dispatch: DispatchEstimate;
  /** How many children a fan-out would actually create. */
  plannedChildCount: number;
  weights?: UtilityWeights;
}

export interface ExecutionAuthorization {
  outcome: DecisionOutcome;
  /** The market's receipt. Null when a hard gate decided, because a gate is not
   *  a ranking and presenting one as a ranking would invent a comparison
   *  nobody made. */
  decision: ActionDecision | null;
  /** Which gate fired, when one did. */
  gate?: string;
}

/** Candidates for the delegate-vs-self choice, priced at the margin.
 *
 *  **Marginal, not absolute**, and that is the whole of the design. Every other
 *  candidate in this runtime is an increment — read this file, run that test,
 *  retry differently — and `utility.ts` prices `tokenCost` against what is left
 *  to spend. Handing it the absolute cost of a whole task makes both options
 *  score as though they would consume the budget, which rejects the expensive
 *  one on `insufficient_budget` and drives the cheap one negative. The
 *  comparison then never happens: the market falls through to its `continue`
 *  fallback and delegation becomes unreachable at every width.
 *
 *  So self-execution is the **null option** and carries no cost at all — it is
 *  the thing that happens if nobody decides anything — and delegation carries
 *  only what splitting *adds*:
 *
 *   - it pays for the planning and synthesis dispatches, which exist only
 *     because the work was split;
 *   - it buys the wall clock of all but the longest child, net of those two
 *     extra runs;
 *   - it risks a child coming back with the wrong thing.
 *
 *  This is deliberately the same shape `execution/workstreams.ts` already uses
 *  for `parallelize` against `serialize`, and for the same reason: a scheduler
 *  that only ever proposes the fast option has not made a decision.
 *
 *  Exported so a benchmark can price the same choice offline from a recorded
 *  state without starting a runtime. */
export function executionCandidates(input: {
  economics: DecideExecutionResult;
  dispatch: DispatchEstimate;
  plannedChildCount: number;
}): ActionCandidate[] {
  const children = Math.max(1, Math.floor(input.plannedChildCount));
  const breakdown = input.economics.breakdown;
  const score = breakdown.score ?? 0;
  const threshold = breakdown.threshold ?? 0;

  // What splitting adds, and nothing that both options pay. The k children's
  // own dispatches are excluded on purpose: doing those k pieces of work is the
  // task, and this node pays for them whether it does them itself or hands them
  // out.
  const extraDispatches = 2;
  const coordinationTokens = Math.max(0, input.dispatch.tokens) * extraDispatches;
  // Serial k dispatches against plan + one child + synthesis. Negative for a
  // narrow split, which is the honest answer: a two-way split costs two extra
  // runs to save nothing.
  const latencySaved = Math.max(0, input.dispatch.latencyMs) * (children - (extraDispatches + 1));

  const self = actionCandidate({
    id: 'execution:self',
    // Not a new verb. Doing the work in this node's own sandbox *is* the
    // healthy default the vocabulary already calls `continue`.
    kind: 'continue',
    capability: 'execution.self',
    // The null option, and it spends nothing extra: doing the work here is what
    // happens if nobody authorizes anything else.
    confidence: 1,
    metadata: { children, source: 'decide-execution' },
  });

  const delegate = actionCandidate({
    id: 'execution:delegate',
    kind: 'parallelize',
    capability: 'execution.delegate',
    // Coordination *is* the token cost here — a planner and a synthesizer are
    // dispatches nobody would buy if the work were not being split. Stated
    // once, as coordination: `utility.ts` sums `tokenCost + coordinationCost`,
    // so setting both would charge the same two dispatches twice.
    coordinationCost: coordinationTokens,
    latencyCost: latencySaved < 0 ? -latencySaved : 0,
    expectedLatencyBenefit: Math.max(0, latencySaved),
    // The existing economics' own margin, carried as a *quality* benefit
    // because that is what it measures and because that is the term the
    // arithmetic reads. `decideExecution`'s `estimatedValue` is the value of
    // handing work to a child, and its whole content is that a goal too broad
    // for one agent is likelier to come back complete if it is split.
    //
    // Deliberately not `expectedProgress`: nothing in `utility.ts` scores that
    // field, so the economics' verdict would have been computed, recorded and
    // then silently ignored — the quietest possible way for a decision layer
    // to stop working.
    expectedQualityBenefit: clamp01(score - threshold),
    // A child can come back with the wrong thing, and the more of them there
    // are the likelier that is. `riskPenalty` is the existing model's own word
    // for the same fact on a complex goal.
    failureRisk: clamp01((children - 1) * 0.1 + (breakdown.riskPenalty ?? 0)),
    qualityRisk: clamp01(breakdown.riskPenalty ?? 0),
    confidence: clamp01(0.5 + Math.abs(score - threshold)),
    metadata: {
      children, source: 'decide-execution',
      estimate: delegationEstimate(input.dispatch, children),
    },
  });

  return [self, delegate];
}

export function authorizeExecution(input: ExecutionAuthorizationInput): ExecutionAuthorization {
  const { economics } = input;
  const breakdown = economics.breakdown;

  // Authority, not value. Each of these is a rule the node is subject to, and a
  // score that could move one is not a boundary.
  if (economics.outcome === 'ESCALATE') {
    return { outcome: 'ESCALATE', decision: null, gate: 'budget-floor' };
  }
  if (breakdown.reason_no_spawn_authority) {
    return { outcome: 'SELF_EXECUTE', decision: null, gate: 'no-spawn-authority' };
  }
  if (breakdown.reason_no_agent_allowance) {
    return { outcome: 'SELF_EXECUTE', decision: null, gate: 'no-agent-allowance' };
  }
  if (breakdown.reason_single_unit_of_work) {
    return { outcome: 'SELF_EXECUTE', decision: null, gate: 'single-unit-of-work' };
  }
  // The estimate source says the goal does not come apart well enough to be
  // worth offering. Honoured rather than re-litigated: the market's job is to
  // veto an expensive action, not to propose one its own estimator rejected.
  if (economics.outcome !== 'DELEGATE') {
    return { outcome: 'SELF_EXECUTE', decision: null, gate: 'economics-declined' };
  }

  const candidates = executionCandidates(input);
  const delegate = candidates.find((candidate) => candidate.kind === 'parallelize')!;

  // The market **vetoes**; it does not re-decide. That distinction is the whole
  // contract, and getting it wrong in the other direction was tempting: a
  // ranking here would be a second delegation economics competing with
  // `decideExecution`'s, and the two would drift — which is precisely what the
  // architecture forbids.
  //
  // So `decideExecution` remains the only thing that decides *whether splitting
  // is worthwhile*, and what the market adds is the set of checks it never
  // had: is this affordable, does it survive the recovery reserve, does it
  // clear the quality floor, is the run under a hard stop, does it need an
  // approval. Those are exactly `evaluateActionUtility`'s hard constraints, and
  // they are the reason a fan-out could previously start on a run the economic
  // state already knew was over.
  const veto = evaluateActionUtility(delegate, input.state, input.weights);

  // Ranked anyway, and recorded. The comparison is not authoritative yet — a
  // benchmark needs to show that the market's ordering beats `decideExecution`'s
  // threshold before anything is allowed to act on it — but a receipt nobody
  // can attribute a regression with is a receipt that was not worth writing.
  const decision = chooseEconomicAction({
    state: input.state,
    candidates,
    weights: input.weights,
  });

  if (!veto.allowed) {
    return {
      outcome: 'SELF_EXECUTE',
      decision,
      gate: veto.reasonCodes.find((code) =>
        code === 'hard_stop' || code === 'safety_violation' || code === 'requires_approval'
        || code === 'quality_floor' || code === 'insufficient_budget') ?? 'vetoed',
    };
  }

  return { outcome: 'DELEGATE', decision };
}
