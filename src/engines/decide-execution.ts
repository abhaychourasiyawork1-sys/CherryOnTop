import { scoreDelegation, type EconomicsInput } from './economics.js';
import type { Authority } from '../schemas/node-contract.js';
import type { DecisionOutcome } from '../schemas/decision.js';

/** What one kind of dispatch is expected to cost, in dollars, and what it could
 *  cost if the belief behind the price is wrong. Both come from the Action
 *  Market's own estimate for that dispatch — the same numbers that price every
 *  other execution choice — never from a table. */
export interface RolePrice {
  expectedUsd: number;
  conservativeUsd: number;
  /** Wall-clock of one such dispatch, when the market priced it. */
  latencyMs?: number;
}

/** The market's price for each way of getting the work done.
 *
 *   - `solo` — the node does it itself, at the difficulty it cannot rule out;
 *   - `plan` — the dispatch that works out how to split it (paid whether or not
 *     it splits);
 *   - `children` — every child together, each a narrower piece and so an easier
 *     dispatch than the whole;
 *   - `synth` — combining what came back.
 *
 *  Delegating is worth it exactly when the work comes apart cheaply enough that
 *  planning it, doing the pieces and combining them beats doing it whole. */
export interface DelegationPricing {
  solo: RolePrice;
  plan: RolePrice;
  children: RolePrice;
  synth: RolePrice;
  /** How many pieces the split is priced as: the least a split can be. */
  childCount: number;
}

/** A split is at least two pieces — that is what makes it a split, not a tuning
 *  choice. More children can only be cheaper per piece; pricing the minimum is
 *  the conservative reading. */
export const MIN_SPLIT = 2;

/** The least budget worth starting an agent with: below this a sandbox costs
 *  more to start than the work it could do inside it. No longer gates splits
 *  (the market prices those); assignment recovery still uses it to decide
 *  whether a revision or replacement can be funded.
 *  ponytail: fixed floor, price rework through priceDelegation when recovery joins the market. */
export const MIN_AGENT_BUDGET_USD = 0.5;

export interface DecideExecutionInput {
  goal: string;
  authority: Authority;
  /** The calibrated probability, from System-1, that the work comes apart into
   *  independent pieces. Absent means nobody knows, and the node does the work
   *  itself: paying a planner to be told "no" is the expensive mistake. */
  splitProbability?: number;
  /** What each way of getting the work done costs, from the market. Absent
   *  means it could not be priced, which is also "do it yourself". */
  pricing?: DelegationPricing;
  /** Named signals behind the call, merged into the breakdown so a reader can
   *  see exactly why it did or did not split. */
  signals?: Record<string, number>;
}

export interface DecideExecutionResult {
  outcome: DecisionOutcome;
  breakdown: Record<string, number>;
}

/** What delegating costs on average, against doing the work whole.
 *
 *  `E[delegate] = plan + P·(children + synth) + (1−P)·solo`: the planner is
 *  paid either way; with probability P it finds a split and the pieces and
 *  their combination follow, otherwise the node still has to do it alone.
 *  Delegating wins when `P·solo − plan − P·(children + synth) > 0`, which is
 *  the delegation formula (value − cost ≥ threshold) with a threshold of
 *  nothing: the value is the solo work avoided, the cost is everything spent
 *  finding out and splitting. */
export function economicsInputFor(pricing: DelegationPricing, splitProbability: number): EconomicsInput {
  const p = Math.min(1, Math.max(0, splitProbability));
  return {
    estimatedValue: p * pricing.solo.expectedUsd,
    modelCost: pricing.plan.expectedUsd + p * (pricing.children.expectedUsd + pricing.synth.expectedUsd),
    latencyCost: 0,
    coordinationCost: 0,
    verificationCost: 0,
    riskPenalty: 0,
    threshold: 0,
  };
}

/** What the split must be able to cover if it goes ahead: the plan, every child
 *  and the synthesis, each at what it could cost — not what it is hoped to. A
 *  node authorised for less cannot afford its own delegation. */
export function requiredBudgetUsd(pricing: DelegationPricing): number {
  return pricing.plan.conservativeUsd + pricing.children.conservativeUsd + pricing.synth.conservativeUsd;
}

export function decideExecution(input: DecideExecutionInput): DecideExecutionResult {
  if (!input.authority.spawn_children) {
    return { outcome: 'SELF_EXECUTE', breakdown: { score: 0, reason_no_spawn_authority: 1 } };
  }

  const signals = input.signals ?? {};

  // No judgment that the work splits is no reason to pay for finding out.
  if (input.splitProbability === undefined || !input.pricing) {
    return {
      outcome: 'SELF_EXECUTE',
      breakdown: { ...signals, score: 0, reason_single_unit_of_work: 1 },
    };
  }

  const economics = scoreDelegation(economicsInputFor(input.pricing, input.splitProbability));
  if (!economics.delegate) {
    return { outcome: 'SELF_EXECUTE', breakdown: { ...signals, ...economics.breakdown, score: economics.score } };
  }

  // Splitting means funding this node's own planning and synthesis runs *and*
  // every child — so the question is whether the authority covers all of it.
  const requiredBudget = requiredBudgetUsd(input.pricing);
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
