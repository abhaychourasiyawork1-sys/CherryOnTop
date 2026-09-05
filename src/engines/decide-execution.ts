import { scoreDelegation, type EconomicsInput } from './economics.js';
import type { Authority } from '../schemas/node-contract.js';
import type { DecisionOutcome } from '../schemas/decision.js';

export interface DecideExecutionInput {
  goal: string;
  authority: Authority;
  complexity: 'low' | 'medium' | 'high';
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
export const CHILD_BUDGET_USD = 1;

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

  const economics = scoreDelegation(defaultEconomicsInput(input.complexity));
  if (!economics.delegate) {
    return { outcome: 'SELF_EXECUTE', breakdown: { ...economics.breakdown, score: economics.score } };
  }

  if (input.authority.budget_usd < CHILD_BUDGET_USD) {
    return {
      outcome: 'ESCALATE',
      breakdown: {
        ...economics.breakdown, score: economics.score,
        requiredBudget: CHILD_BUDGET_USD, availableBudget: input.authority.budget_usd,
      },
    };
  }

  return { outcome: 'DELEGATE', breakdown: { ...economics.breakdown, score: economics.score } };
}
