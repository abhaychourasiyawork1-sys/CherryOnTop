/** The Action Market: the one place the runtime decides what to do next.
 *
 *  Every specialized module is an *action provider* now. The model router
 *  proposes Harness × Model × Effort candidates, the delegation economics
 *  propose self vs delegate, the evidence planner proposes reads, the recovery
 *  engine proposes retries and switches. Each may say what its action is
 *  expected to do (an `ActionTransitionEstimate`); none of them chooses. The
 *  choice is made here, once, by one rule:
 *
 *      pick the feasible action with the lowest conservative expected cost to
 *      finish the task, subject to hard constraints and the quality floor.
 *
 *  The order of operations is the design:
 *
 *   1. hard constraints — safety, authority, approval, capability, budget.
 *      Before any estimate exists, so no estimate can buy past one;
 *   2. transition estimation — deterministic, cached, empirical, signals;
 *   3. dominance pruning — drop what something else beats on every axis;
 *   4. quality floor — against the conservative success bound, not the mean;
 *   5. cost-to-go — Q(s,a) = C_now + E[V(s')], ranked on its upper bound;
 *   6. deterministic tie-break — expected cost, confidence, then stable id.
 *
 *  What it deliberately does not do: call a model, touch a database, or read
 *  what the task is *about*. System-1 is an estimate refiner the caller may buy
 *  when `semanticRefinementValue` says it pays; the market then runs again. */
import { randomUUID } from 'node:crypto';
import type { DecideExecutionResult, DelegationPricing } from '../engines/decide-execution.js';
import type { Authority } from '../schemas/node-contract.js';
import type { DecisionOutcome } from '../schemas/decision.js';
import { clamp01 } from '../efficiency/policy-types.js';
import { SHRINKAGE_K } from '../learning/hierarchical.js';
import { receipt, type DecisionReceipt, type DecisionEstimate } from './types.js';
import {
  normalizeActionCandidate, actionCandidate, type ActionCandidate, type ActionDecision, type CandidateSnapshot,
} from './actions.js';
import {
  evaluateAction, hardConstraints, deterministicEstimate, signalEstimate, isNullAction,
  stateValue, remainingWorkTokens, usdPerToken, isConstraintCode,
  type ActionEvaluation, type DecisionFault,
} from './utility.js';
import {
  estimateTransition, candidateFingerprint,
  type ActionTransitionEstimate, type EstimationContext, type FunnelStats,
} from './transition.js';
import type { EconomicState } from './state.js';
import { assessDecisionTrust } from './trust.js';

export * from './types.js';
// One import point for the whole decision layer. The strategy gate names the
// shape of what the market chose; it does not choose.
export {
  decideStrategy, deterministicEvidence, sanitizeClassification, strategyReceipt,
} from './strategy-gate.js';
export type {
  ExecutionStrategy, StrategyDecision, StrategyEvidence, StrategyPrior,
  StrategyClassification, StrategyClassifier, DecideStrategyInput,
} from './strategy-gate.js';

/** What a dispatch is expected to cost, from the ledger rather than a guess. */
export interface DispatchEstimate extends DecisionEstimate {}

export interface SafetyInput {
  authority: Authority;
  spentUsd: number;
  /** Set when a person must approve before anything happens. */
  requiresApproval?: boolean;
}

/** The authority rules that outrank every cost, for callers that have an
 *  `Authority` rather than an `EconomicState`. Null when the decision is open. */
export function hardGates(input: SafetyInput): DecisionReceipt | null {
  if (input.requiresApproval) {
    return receipt({
      chosen: 'WAIT', gate: 'approval', fastPath: true,
      reason: 'a person has to approve this before anything is spent',
    });
  }
  // Zero means nobody costed this node, which is not the same as out of money.
  if (input.authority.budget_usd > 0 && input.spentUsd >= input.authority.budget_usd) {
    return receipt({
      chosen: 'STOP', gate: 'budget', fastPath: true,
      reason: `budget spent — $${input.spentUsd.toFixed(2)} of $${input.authority.budget_usd.toFixed(2)}`,
    });
  }
  return null;
}

/** What a fan-out costs, as a function of how wide it is: one planning run,
 *  k children, one synthesis. Latency is plan + one child + synthesis, because
 *  children run concurrently. */
export function delegationEstimate(dispatch: DispatchEstimate, childCount: number): DispatchEstimate {
  const children = Math.max(1, Math.floor(childCount));
  const dispatches = children + 2;
  return {
    tokens: dispatch.tokens * dispatches,
    latencyMs: dispatch.latencyMs * 3,
    costUsd: dispatch.costUsd * dispatches,
  };
}

// ---------------------------------------------------------------------------
// The market
// ---------------------------------------------------------------------------

/** Two conservative costs this close are a tie. The same 1e-9 the rest of the
 *  decision layer uses: a sixteenth-decimal difference must not make the
 *  winner depend on arrival order. */
const TIE_EPSILON = 1e-12;

/** How many rejections a receipt names. Enough to explain a surprising answer. */
const MAX_RECORDED_REJECTIONS = 8;

/** How many ranked candidates survive pruning into the receipt and into any
 *  semantic refinement. More than this is not a decision, it is a search. */
export const MAX_RETAINED_CANDIDATES = 6;

/** Letting the agent get on with it. A real candidate rather than a null
 *  return, so it is priced — at V(s), which is not zero — and audited. */
export function continueAction(): ActionCandidate {
  return actionCandidate({ id: 'continue', kind: 'continue', capability: 'agent.continue', confidence: 1 });
}

function stopAction(): ActionCandidate {
  return actionCandidate({ id: 'stop', kind: 'stop', capability: 'runtime.stop', confidence: 1 });
}

export interface EconomicDecisionInput {
  state: EconomicState;
  candidates: ActionCandidate[];
  /** Faults the caller observed. Present, they make every intervention
   *  infeasible; the null action remains. */
  faults?: readonly DecisionFault[];
  /** Estimates a provider already made, keyed by candidate id. They enter the
   *  funnel above the cache: a provider that knows is not second-guessed by a
   *  bucketed guess. Deterministic answers still win over them. */
  estimates?: Readonly<Record<string, ActionTransitionEstimate>>;
  estimation?: EstimationContext;
  /** A different model of what finishing costs, priced at the funnel's signal
   *  level and nowhere else — the governor's risk-aware valuation
   *  (`governor/risk.ts`). Both halves must come from the *same* model: the
   *  signal estimate prices each candidate, and `stateValueUsd` is V(s) under
   *  that model, which every candidate's advantage is measured against. Hard
   *  constraints, the deterministic level, provider estimates, the cache, the
   *  quality floor and the ranking are untouched: this changes a price, never
   *  who chooses. */
  valuation?: {
    signal: (candidate: ActionCandidate, state: EconomicState) => ActionTransitionEstimate;
    stateValueUsd: number;
  };
  /** What the runtime can carry out. A candidate it cannot is refused as
   *  `unavailable:not_carried_out` — priced and kept in the receipt, never
   *  chosen. The null action is always executable. Absent, nothing is refused
   *  for this reason (the diagnosis ladder and tests price abstract menus). */
  executable?: (candidate: ActionCandidate) => boolean;
  /** Injected so a decision is reproducible in a test. Production never
   *  passes it. */
  decisionId?: string;
  nowMs?: () => number;
}

interface Priced {
  candidate: ActionCandidate;
  evaluation: ActionEvaluation;
}

/** The one entry point the runtime asks "what now?" through. Pure: it reads
 *  the state and never moves it — a decision becomes real only when
 *  `commitAction` reserves for it against the same state version. */
export function chooseEconomicAction(input: EconomicDecisionInput): ActionDecision {
  const { state } = input;
  const now = input.nowMs ?? Date.now;
  const startedMs = now();
  const stats: FunnelStats = { cacheHits: 0, cacheMisses: 0, estimatorCalls: 0 };

  const supplied = (input.candidates ?? []).map(normalizeActionCandidate).map((c) => (
    input.executable && !isNullAction(c) && !input.executable(c)
      ? { ...c, metadata: { ...c.metadata, infeasible: 'not_carried_out' } } : c));
  // The null action is always on the menu unless a provider supplied its own
  // version of it (the execution market's candidates are all "carry on, on
  // this candidate").
  const candidates = supplied.some((c) => c.kind === 'continue') ? supplied : [...supplied, continueAction()];

  const price = (candidate: ActionCandidate): Priced => {
    // Constraints first: a candidate a gate refuses is never estimated, so no
    // estimate — and no estimator's cost — is spent on something forbidden.
    const gate = hardConstraints(candidate, state, input.faults);
    const signal = input.valuation?.signal ?? signalEstimate;
    const estimate = gate.allowed
      ? estimateFor(candidate, state, input, stats)
      : (deterministicEstimate(candidate, state) ?? signal(candidate, state));
    return {
      candidate,
      evaluation: evaluateAction(candidate, state, {
        estimate, faults: input.faults, baselineValueUsd: input.valuation?.stateValueUsd,
      }),
    };
  };

  const priced = candidates.map(price);
  const feasible = priced.filter((p) => p.evaluation.allowed);
  const rejected = priced.filter((p) => !p.evaluation.allowed);
  const { kept, pruned } = dominancePrune(feasible);
  const ranked = [...kept].sort(compareCost);

  const rejectionCodes = rejected.slice(0, MAX_RECORDED_REJECTIONS).flatMap((p) =>
    p.evaluation.reasonCodes
      .filter(isConstraintCode)
      .map((code) => `rejected:${p.candidate.id}:${code}`));

  const decide = (chosen: Priced, extra: string[], blocked = false): ActionDecision => {
    const runnerUp = ranked.find((p) => p !== chosen);
    return {
      decisionId: input.decisionId ?? `dec-${randomUUID()}`,
      stateVersion: state.version,
      action: chosen.candidate,
      // What this is expected to save over carrying on as we are. Positive
      // means an intervention the numbers justify.
      utility: chosen.evaluation.advantageUsd,
      reasonCodes: [
        ...chosen.evaluation.reasonCodes, ...extra,
        // Which confidence was weak, so a receipt can say what to fix.
        ...(isNullAction(chosen.candidate) ? [] : assessDecisionTrust({ state, action: chosen.candidate }).reasonCodes),
        ...(state.constraints.hardStop && !chosen.evaluation.reasonCodes.includes('hard_stop') ? ['hard_stop'] : []),
        ...rejectionCodes,
      ],
      // The orchestrator's confidence in its own reading caps every decision
      // it makes: doubt reduces pressure.
      confidence: Math.min(chosen.evaluation.estimate.confidence, chosen.candidate.confidence,
        isNullAction(chosen.candidate) ? 1 : state.trajectory.orchestrationConfidence),
      estimate: chosen.evaluation.estimate,
      expectedCostUsd: chosen.evaluation.expectedCostUsd,
      conservativeCostUsd: chosen.evaluation.conservativeCostUsd,
      successLowerBound: chosen.evaluation.successLowerBound,
      margin: runnerUp ? marginBetween(chosen.evaluation, runnerUp.evaluation) : null,
      ranked: ranked.slice(0, MAX_RETAINED_CANDIDATES).map(summary),
      rejected: rejected.slice(0, MAX_RECORDED_REJECTIONS).map((p) => ({
        id: p.candidate.id, reasonCodes: p.evaluation.reasonCodes,
      })),
      pruned: pruned.map((p) => p.candidate.id),
      candidates: priced.map((p) => snapshotOf(p, chosen, ranked, pruned)),
      blocked,
      overhead: {
        candidateCount: candidates.length,
        estimatorCalls: stats.estimatorCalls,
        cacheHits: stats.cacheHits,
        cacheMisses: stats.cacheMisses,
        latencyMs: Math.max(0, now() - startedMs),
      },
    };
  };

  const best = ranked[0];
  if (best) {
    const extra = [isNullAction(best.candidate) && best.candidate.capability === 'agent.continue'
      ? 'no_justified_opportunity'
      : 'chosen_by_cost_to_go'];
    const runnerUp = ranked[1];
    if (runnerUp && Math.abs(runnerUp.evaluation.conservativeCostUsd - best.evaluation.conservativeCostUsd) <= TIE_EPSILON
      && Math.abs(runnerUp.evaluation.expectedCostUsd - best.evaluation.expectedCostUsd) <= TIE_EPSILON) {
      extra.push(best.candidate.confidence === runnerUp.candidate.confidence ? 'tie_broken_on_id' : 'tie_broken_on_confidence');
    }
    return decide(best, extra);
  }

  // Nothing is feasible. Stopping is terminal and is only the answer because
  // nothing else is permitted — which is a different fact from stopping
  // because it was cheapest, so the receipt says which.
  const stop = price(stopAction());
  // Under a hard stop, stopping is the one permitted action — a real answer,
  // not a blocked market.
  return stop.evaluation.allowed
    ? decide(stop, ['continuation_not_permitted'])
    : decide(stop, ['continuation_not_permitted', 'blocked:no_feasible_action'], true);
}

function estimateFor(
  candidate: ActionCandidate,
  state: EconomicState,
  input: EconomicDecisionInput,
  stats: FunnelStats,
): ActionTransitionEstimate {
  const provided = input.estimates?.[candidate.id];
  return estimateTransition(candidate, state, input.estimation ?? {}, {
    deterministic: (c, s) => deterministicEstimate(c, s) ?? provided ?? null,
    signals: input.valuation?.signal ?? signalEstimate,
  }, stats);
}

/** Drops every candidate another beats on expected cost, conservative cost and
 *  success bound at once. Cheap, and it keeps an expensive semantic refinement
 *  from being spent separating two options neither of which can win. */
function dominancePrune(feasible: Priced[]): { kept: Priced[]; pruned: Priced[] } {
  const kept: Priced[] = [];
  const pruned: Priced[] = [];
  for (const a of feasible) {
    const dominated = feasible.some((b) => b !== a
      && b.evaluation.expectedCostUsd <= a.evaluation.expectedCostUsd
      && b.evaluation.conservativeCostUsd <= a.evaluation.conservativeCostUsd
      && b.evaluation.successLowerBound >= a.evaluation.successLowerBound
      && (b.evaluation.expectedCostUsd < a.evaluation.expectedCostUsd - TIE_EPSILON
        || b.evaluation.conservativeCostUsd < a.evaluation.conservativeCostUsd - TIE_EPSILON
        || b.evaluation.successLowerBound > a.evaluation.successLowerBound + TIE_EPSILON));
    (dominated ? pruned : kept).push(a);
  }
  return { kept, pruned };
}

function compareCost(a: Priced, b: Priced): number {
  const byConservative = a.evaluation.conservativeCostUsd - b.evaluation.conservativeCostUsd;
  if (Math.abs(byConservative) > TIE_EPSILON) return byConservative;
  const byExpected = a.evaluation.expectedCostUsd - b.evaluation.expectedCostUsd;
  if (Math.abs(byExpected) > TIE_EPSILON) return byExpected;
  const byConfidence = b.candidate.confidence - a.candidate.confidence;
  if (Math.abs(byConfidence) > TIE_EPSILON) return byConfidence;
  // The last tie-break is the candidate's own stable id, never its kind and
  // never anything read off the goal.
  return a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0;
}

function snapshotOf(p: Priced, chosen: Priced, ranked: Priced[], pruned: Priced[]): CandidateSnapshot {
  const rank = ranked.indexOf(p);
  const source = p.candidate.metadata.candidateSource;
  return {
    id: p.candidate.id,
    fingerprint: candidateFingerprint(p.candidate),
    kind: p.candidate.kind,
    capability: p.candidate.capability,
    source: typeof source === 'string' ? source : 'caller',
    status: p === chosen ? 'chosen' : !p.evaluation.allowed ? 'rejected' : pruned.includes(p) ? 'pruned' : 'ranked',
    reasonCodes: p.evaluation.reasonCodes,
    expectedCostUsd: p.evaluation.expectedCostUsd,
    conservativeCostUsd: p.evaluation.conservativeCostUsd,
    successLowerBound: p.evaluation.successLowerBound,
    immediateTokens: p.evaluation.estimate.immediateCost.tokens,
    provenance: p.evaluation.estimate.provenance,
    confidence: p.candidate.confidence,
    rank: rank >= 0 ? rank + 1 : null,
    ...(Array.isArray(p.candidate.metadata.addresses)
      ? { addresses: (p.candidate.metadata.addresses as unknown[]).filter((a): a is string => typeof a === 'string') } : {}),
  };
}

export interface DecisionMargin {
  /** Q₂ − Q₁ on the conservative cost the market ranks on, in dollars. */
  absoluteUsd: number;
  /** The same, relative to the winner's cost. Small means a near coin toss. */
  relative: number;
}

function marginBetween(best: ActionEvaluation, second: ActionEvaluation): DecisionMargin {
  const absoluteUsd = Math.max(0, second.conservativeCostUsd - best.conservativeCostUsd);
  return { absoluteUsd, relative: absoluteUsd / Math.max(Math.abs(best.conservativeCostUsd), 1e-9) };
}

function summary(p: Priced): NonNullable<ActionDecision['ranked']>[number] {
  return {
    id: p.candidate.id,
    fingerprint: candidateFingerprint(p.candidate),
    expectedCostUsd: p.evaluation.expectedCostUsd,
    conservativeCostUsd: p.evaluation.conservativeCostUsd,
    successLowerBound: p.evaluation.successLowerBound,
    provenance: p.evaluation.estimate.provenance,
  };
}

// ---------------------------------------------------------------------------
// Delegation: a candidate provider feeding the same market
// ---------------------------------------------------------------------------

export interface ExecutionAuthorizationInput {
  state: EconomicState;
  /** The delegation economics, as a gate: its breakdown says whether an
   *  authority rule already decided, and its verdict no longer ranks anything. */
  economics: DecideExecutionResult;
  /** What each way of getting the work done costs, from the market. */
  pricing: DelegationPricing;
  /** System-1's calibrated P(the work splits). */
  splitProbability: number;
}

export interface ExecutionAuthorization {
  outcome: DecisionOutcome;
  /** The market's decision. Null when an authority gate decided, because a
   *  gate is not a ranking. */
  decision: ActionDecision | null;
  gate?: string;
}

/** Self vs delegate, priced in dollars by the market.
 *
 *  Self-execution costs the solo run. Delegation costs the planner (paid
 *  whichever way it turns out), then with probability P the pieces and their
 *  combination, otherwise the solo run after all. Each carries its expected and
 *  its conservative cost, so a delegate the market is unsure of must save by
 *  more than its doubt — the same rule every other candidate is held to.
 *
 *  Exported so a benchmark can price the choice offline from a recorded state. */
export function executionCandidates(input: {
  state: EconomicState;
  pricing: DelegationPricing;
  splitProbability: number;
}): { candidates: ActionCandidate[]; estimates: Record<string, ActionTransitionEstimate> } {
  const { pricing } = input;
  const p = clamp01(input.splitProbability);
  const price = usdPerToken(input.state);
  const tokensFor = (usd: number) => (Number.isFinite(usd) ? Math.ceil(usd / price) : Number.MAX_SAFE_INTEGER);

  const selfUsd = pricing.solo.expectedUsd;
  const selfUpper = Math.max(selfUsd, pricing.solo.conservativeUsd);
  const delegateUsd = pricing.plan.expectedUsd
    + p * (pricing.children.expectedUsd + pricing.synth.expectedUsd) + (1 - p) * selfUsd;
  const delegateUpper = Math.max(delegateUsd, pricing.plan.conservativeUsd
    + p * (pricing.children.conservativeUsd + pricing.synth.conservativeUsd) + (1 - p) * pricing.solo.conservativeUsd);
  // Children run side by side, so the pieces cost one dispatch of wall clock.
  const selfLatency = pricing.solo.latencyMs ?? 0;
  const delegateLatency = (pricing.plan.latencyMs ?? 0) + (pricing.children.latencyMs ?? 0) + (pricing.synth.latencyMs ?? 0);

  const self = actionCandidate({
    id: 'execution:self', kind: 'continue', capability: 'execution.self',
    tokenCost: tokensFor(selfUsd), latencyCost: selfLatency, confidence: 1,
    metadata: { children: pricing.childCount, source: 'decide-execution' },
  });
  const delegate = actionCandidate({
    id: 'execution:delegate', kind: 'parallelize', capability: 'execution.delegate',
    tokenCost: tokensFor(delegateUsd), latencyCost: delegateLatency,
    confidence: clamp01(delegateUpper > 0 ? delegateUsd / delegateUpper : 1),
    metadata: { children: pricing.childCount, source: 'decide-execution' },
  });

  const estimate = (candidate: ActionCandidate, usd: number, upper: number): ActionTransitionEstimate => ({
    actionId: candidate.id,
    immediateCost: { tokens: candidate.tokenCost, usd, latencyMs: candidate.latencyCost },
    outcomes: [{ probability: 1, completed: false, succeeded: true, nextStateDelta: {} }],
    expectedRemainingCost: { tokens: 0, usd: 0, latencyMs: 0 },
    bounds: { successLowerBound: 1, costUpperBoundUsd: upper },
    confidence: candidate.confidence,
    provenance: 'hybrid',
    evidenceIds: [],
  });
  return {
    candidates: [self, delegate],
    estimates: {
      [self.id]: estimate(self, selfUsd, selfUpper),
      [delegate.id]: estimate(delegate, delegateUsd, delegateUpper),
    },
  };
}

/** Whether to do the work or split it — decided by the market.
 *
 *  Authority gates run first and cannot be bought past: no spawn authority, no
 *  agent allowance, not enough budget to fund the plan, the pieces and the
 *  synthesis (an escalation to a person), or a goal nobody judged to split.
 *  Everything past them is a cost comparison between the two candidates
 *  `executionCandidates` prices, and the market chooses. */
export function authorizeExecution(input: ExecutionAuthorizationInput): ExecutionAuthorization {
  const breakdown = input.economics.breakdown;

  if (input.economics.outcome === 'ESCALATE') return { outcome: 'ESCALATE', decision: null, gate: 'budget-floor' };
  if (breakdown.reason_no_spawn_authority) return { outcome: 'SELF_EXECUTE', decision: null, gate: 'no-spawn-authority' };
  if (breakdown.reason_no_agent_allowance) return { outcome: 'SELF_EXECUTE', decision: null, gate: 'no-agent-allowance' };
  if (breakdown.reason_single_unit_of_work) return { outcome: 'SELF_EXECUTE', decision: null, gate: 'single-unit-of-work' };

  const { candidates, estimates } = executionCandidates(input);
  const decision = chooseEconomicAction({ state: input.state, candidates, estimates });
  if (decision.action.id === 'execution:delegate') return { outcome: 'DELEGATE', decision };

  const delegateRejection = decision.rejected?.find((r) => r.id === 'execution:delegate');
  return {
    outcome: 'SELF_EXECUTE',
    decision,
    gate: delegateRejection?.reasonCodes.find(isConstraintCode)
      ?? (decision.pruned?.includes('execution:delegate') ? 'dominated' : 'costlier'),
  };
}
