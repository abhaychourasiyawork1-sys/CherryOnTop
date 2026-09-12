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
      // A fan-out is the dispatch cost times the children, plus the parent's own
      // planning and synthesis. Two children is the default cap.
      estimate: {
        tokens: input.dispatch.tokens * 2,
        latencyMs: input.dispatch.latencyMs,
        costUsd: input.dispatch.costUsd * 2,
      },
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
      estimate: { tokens: input.dispatch.tokens * 2, latencyMs: input.dispatch.latencyMs, costUsd: input.dispatch.costUsd * 2 },
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
