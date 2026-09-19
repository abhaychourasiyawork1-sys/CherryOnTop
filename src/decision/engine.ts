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
import { decideExecution, type DecideExecutionInput } from '../engines/decide-execution.js';
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
