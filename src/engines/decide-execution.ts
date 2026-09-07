import { scoreDelegation, type EconomicsInput } from './economics.js';
import type { Authority } from '../schemas/node-contract.js';
import type { DecisionOutcome } from '../schemas/decision.js';

export interface DecideExecutionInput {
  goal: string;
  authority: Authority;
  complexity: 'low' | 'medium' | 'high';
  /** Whether the goal looks like several pieces of work. Absent means "no
   *  opinion", which keeps every existing caller and test behaving as before. */
  worthSplitting?: boolean;
  /** Named signals behind that call, merged into the breakdown so a reader can
   *  see exactly why it did or did not split. */
  signals?: Record<string, number>;
}

export interface DecideExecutionResult {
  outcome: DecisionOutcome;
  breakdown: Record<string, number>;
}

// v0.1 has no per-goal cost estimation or historical data (that's Phase 5's
// organizational memory closing the loop described in doc §10) — these are
// the documented conservative defaults the spec calls for until real signals
// exist. The constants exist so the formula has real numbers to run and
// persist today, not because they're calibrated; recalibrate from real
// outcomes once Phase 5 lands, not by guessing better constants now.
// What scales with complexity is the *value* of handing work to a child — a
// one-line typo fix is not worth a whole child node, a sprawling goal is. The
// cost side is close to fixed: spawning, coordinating with, and verifying a
// child costs about the same whatever it was asked to do.
const VALUE_BY_COMPLEXITY: Record<DecideExecutionInput['complexity'], number> = { low: 0.2, medium: 0.7, high: 1.2 };
const THRESHOLD = 0.3;

/** The least a single agent needs to be worth dispatching at all — below this a
 *  sandbox costs more to start than the work it could do inside it. Was
 *  CHILD_BUDGET_USD, a flat amount every child was *given*; now a floor every
 *  child's derived share must clear. */
export const MIN_AGENT_BUDGET_USD = 0.5;

function defaultEconomicsInput(complexity: DecideExecutionInput['complexity']): EconomicsInput {
  return {
    estimatedValue: VALUE_BY_COMPLEXITY[complexity],
    modelCost: 0.1,
    latencyCost: 0.05,
    coordinationCost: 0.15,
    verificationCost: 0.1,
    // A complex goal handed to a child is likelier to come back wrong.
    riskPenalty: complexity === 'high' ? 0.2 : 0,
    threshold: THRESHOLD,
  };
}

export function decideExecution(input: DecideExecutionInput): DecideExecutionResult {
  if (!input.authority.spawn_children) {
    return { outcome: 'SELF_EXECUTE', breakdown: { score: 0, reason_no_spawn_authority: 1 } };
  }

  const signals = input.signals ?? {};

  // Asked and answered before any money is spent: a goal that is plainly one
  // job is done directly. Delegating it would buy a planning sandbox whose only
  // possible useful answer is "this does not split".
  if (input.worthSplitting === false) {
    return {
      outcome: 'SELF_EXECUTE',
      breakdown: { ...signals, score: 0, reason_single_unit_of_work: 1 },
    };
  }

  const economics = scoreDelegation(defaultEconomicsInput(input.complexity));
  if (!economics.delegate) {
    return { outcome: 'SELF_EXECUTE', breakdown: { ...signals, ...economics.breakdown, score: economics.score } };
  }

  // Splitting means funding at least one child *and* this node's own planning
  // and synthesis runs — so the question is whether two shares can clear the
  // floor, not one.
  const requiredBudget = MIN_AGENT_BUDGET_USD * 2;
  if (input.authority.budget_usd < requiredBudget) {
    return {
      outcome: 'ESCALATE',
      breakdown: {
        ...signals, ...economics.breakdown, score: economics.score,
        requiredBudget, availableBudget: input.authority.budget_usd,
      },
    };
  }

  // Nothing to split into. An allowance of zero agents is a node that may not
  // grow an organization however good the economics look.
  if (input.authority.max_child_count < 1) {
    return { outcome: 'SELF_EXECUTE', breakdown: { ...signals, ...economics.breakdown, score: economics.score, reason_no_agent_allowance: 1 } };
  }

  return { outcome: 'DELEGATE', breakdown: { ...signals, ...economics.breakdown, score: economics.score } };
}
