/** Dividing what is left, by what there is to spend it on.
 *
 *  The thing this replaces is a table. `TURNS_BY_BAND` in `efficiency/policy.ts`
 *  gives a "medium" task 45 turns and a "large" one 60; `contextPolicyFor`
 *  gives it a share of the context ceiling from its breadth. Both are
 *  reasonable and both answer the wrong question: they allocate from what the
 *  task *looks like*, before anything has happened, and never revisit it. A
 *  task that turns out to need no exploration still holds an exploration
 *  allowance, and one that discovers it needs a retry has nothing held back for
 *  one.
 *
 *  Here the allowance comes from the opportunities that actually exist right
 *  now. Two states carrying the same label and different opportunities get
 *  different allocations, which is the whole point — and a state with no
 *  opportunities allocates nothing at all, leaving everything unallocated.
 *  **Holding nothing back is the default**, because an allowance reserved for
 *  work nobody has proposed is an allowance the work that *is* happening cannot
 *  use.
 *
 *  Two properties worth stating because they are easy to lose:
 *
 *   - **Nothing is allocated beyond what is asked for.** A bucket is capped at
 *     the cost of the opportunities in it. Without the cap, a state with one
 *     cheap validation opportunity and nothing else would be handed the entire
 *     remaining budget for validation.
 *   - **The reserve is released when the reason for it goes away.** Recovery is
 *     a bucket like any other, filled from recovery opportunities. When the run
 *     stops failing there are none, and the reserve is zero without anything
 *     having to remember to release it. */
import { evaluateActionUtility, type UtilityWeights } from './utility.js';
import type { ActionCandidate } from './actions.js';
import type { EconomicState } from './state.js';

export interface BudgetAllocation {
  /** What the next dispatch's prompt may cost. */
  context: number;
  /** What the agent may spend looking around. */
  exploration: number;
  /** What acquiring specific evidence may cost. */
  evidence: number;
  /** What proving the work may cost. */
  validation: number;
  /** Held back against a retry worth making. */
  recoveryReserve: number;
  /** What deciding all of the above costs. Charged against the optimization
   *  allowance, never against the work. */
  orchestration: number;
  /** Everything not claimed. Large is *good*: it is budget the agent may spend
   *  on whatever it turns out to need, and a plan that allocates every token in
   *  advance is a plan that has decided the run cannot surprise it. */
  unallocated: number;
}

export const EMPTY_ALLOCATION: BudgetAllocation = {
  context: 0, exploration: 0, evidence: 0, validation: 0,
  recoveryReserve: 0, orchestration: 0, unallocated: 0,
};

/** Which allowance an opportunity draws on.
 *
 *  By what the action *is*, never by what the task is. The one split that reads
 *  the capability rather than the kind is context against other evidence: both
 *  are evidence acquisition, and they are budgeted apart because one is paid at
 *  the start of a dispatch and the other during it — a single bucket would let
 *  a large prompt silently consume the allowance for opening the file the agent
 *  turns out to need. */
type SpendBucket = 'context' | 'exploration' | 'evidence' | 'validation' | 'recoveryReserve';

function bucketFor(candidate: ActionCandidate): SpendBucket | null {
  switch (candidate.kind) {
    case 'validate': return 'validation';
    case 'recover': return 'recoveryReserve';
    case 'explore': return 'exploration';
    case 'acquire_evidence':
    case 'reuse_evidence':
      return candidate.capability.startsWith('context.') ? 'context' : 'evidence';
    // `continue`, `stop`, `constrain`, `parallelize` and `serialize` spend
    // coordination rather than work. Their cost is accounted as orchestration
    // below rather than given a bucket of its own, because none of them buys
    // anything the agent could spend an allowance on.
    default: return null;
  }
}

export interface AllocateBudgetInput {
  state: EconomicState;
  opportunities: ActionCandidate[];
  weights?: UtilityWeights;
}

export function allocateBudget(input: AllocateBudgetInput): BudgetAllocation {
  const { state } = input;
  const remaining = state.resources.remainingTokens;
  if (remaining <= 0) return { ...EMPTY_ALLOCATION };

  const opportunities = input.opportunities ?? [];

  // What the optimizer will spend deciding: the overhead the live opportunities
  // declare, bounded by the allowance it actually has left. Taken off the top,
  // because a decision is made before the thing it decides about.
  const optimizationLeft = Math.max(
    0, state.resources.optimizationTokens - state.resources.optimizationConsumedTokens,
  );
  const declaredOverhead = opportunities.reduce((sum, c) => sum + c.orchestrationCost, 0);
  const orchestration = Math.min(remaining, Math.min(optimizationLeft, declaredOverhead));
  const pool = Math.max(0, remaining - orchestration);

  // Demand and value, per bucket. Value is the utility the opportunity was
  // priced at — the same arithmetic the engine ranks with, so a bucket cannot
  // be funded on a basis the decision to spend it would disagree with.
  const demand = new Map<SpendBucket, number>();
  const value = new Map<SpendBucket, number>();
  for (const candidate of opportunities) {
    const bucket = bucketFor(candidate);
    if (!bucket) continue;
    const verdict = evaluateActionUtility(candidate, state, input.weights);
    // A forbidden or worthless opportunity funds nothing. Allocating against it
    // would hold back budget for something that will never be chosen.
    if (!verdict.allowed || verdict.score <= 0) continue;
    demand.set(bucket, (demand.get(bucket) ?? 0) + candidate.tokenCost + candidate.coordinationCost);
    value.set(bucket, (value.get(bucket) ?? 0) + verdict.score);
  }

  const totalValue = [...value.values()].reduce((sum, v) => sum + v, 0);
  const allocation: BudgetAllocation = { ...EMPTY_ALLOCATION, orchestration };

  if (totalValue > 0) {
    // Two passes. The first caps every bucket at what it actually asked for, so
    // a lone cheap opportunity cannot be handed the whole pool; the second
    // shares out what the caps freed, in the same proportions, among the
    // buckets that still want more. Without the second pass a state whose
    // opportunities are all cheap would leave a large pool unallocated while
    // buckets that wanted it went short.
    let spent = 0;
    const wants = new Map<SpendBucket, number>();
    for (const [bucket, v] of value) {
      const share = (pool * v) / totalValue;
      const capped = Math.min(share, demand.get(bucket) ?? 0);
      allocation[bucket] = capped;
      spent += capped;
      wants.set(bucket, Math.max(0, (demand.get(bucket) ?? 0) - capped));
    }

    let surplus = Math.max(0, pool - spent);
    const stillWanting = [...wants.entries()].filter(([, want]) => want > 0);
    const wantingValue = stillWanting.reduce((sum, [bucket]) => sum + (value.get(bucket) ?? 0), 0);
    if (surplus > 0 && wantingValue > 0) {
      for (const [bucket, want] of stillWanting) {
        const extra = Math.min(want, (surplus * (value.get(bucket) ?? 0)) / wantingValue);
        allocation[bucket] += extra;
      }
    }
  }

  const claimed = allocation.context + allocation.exploration + allocation.evidence
    + allocation.validation + allocation.recoveryReserve + allocation.orchestration;
  allocation.unallocated = Math.max(0, remaining - claimed);

  return allocation;
}

/** Whether an allocation accounts for every token it was given.
 *
 *  Exported for tests and for `doctor`: an allocator that loses tokens is an
 *  allocator whose numbers cannot be added up in a report, and a silent
 *  discrepancy in a budget is the kind of bug that only shows up as an
 *  unexplained overspend months later. */
export function allocationTotal(allocation: BudgetAllocation): number {
  return allocation.context + allocation.exploration + allocation.evidence
    + allocation.validation + allocation.recoveryReserve + allocation.orchestration
    + allocation.unallocated;
}
