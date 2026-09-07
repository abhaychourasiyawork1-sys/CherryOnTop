import type { ExecuteStepResult } from '../execution/execute-step.js';
import type { Authority } from '../schemas/node-contract.js';
import { effectiveAuthority } from '../engines/authority.js';
import { MIN_AGENT_BUDGET_USD } from '../engines/decide-execution.js';

export interface DelegateInput {
  parentId: string;
  goal: string;
  approvedBudgetUsd?: number;
  /** The goals to hand out, one per child. Empty means the planner could not
   *  split the goal. */
  subgoals?: string[];
  /** How many children this node already created. Delegation is a one-time act:
   *  if a fan-out came back with any piece unfinished, the machine's retry used
   *  to re-plan and create a *second* full set of children — duplicating the
   *  pieces that had already succeeded and spending the quota twice. */
  existingChildren?: number;
}

/**
 * The authority a child is created with: a share of what its parent holds.
 *
 * Both limits are **pools the parent divides**, not counters it decrements.
 * That distinction is the whole fix for two bugs that had the same cause:
 *
 *  - `max_child_count` is the number of agents allowed in this node's *whole
 *    subtree*, not the number of children it may create. Creating k children
 *    spends k of it, and the remainder is split evenly among them. Decrementing
 *    by one per generation, as this used to, bounds depth and nothing else: a
 *    root allowed "5" produced a 57-agent organization five levels deep, while
 *    the interface cheerfully promised at most six.
 *
 *  - the budget is divided into k+1 shares, one per child and one kept back for
 *    the parent's own planning and synthesis runs — which are real dispatches
 *    that spend real money. Children used to get a flat $1 regardless of what
 *    the parent held, so a $25 root funded 57 agents at $1 each.
 *
 * Both properties are proved by induction in the tests: an organization can
 * never exceed max_child_count + 1 agents, nor its root's budget.
 *
 * `approvedBudgetUsd`, when set, is a human's explicit grant and is the one
 * thing that may exceed the parent's own share.
 */
export function childAuthority(
  parent: Authority,
  siblingCount: number,
  approvedBudgetUsd?: number,
): Authority {
  const siblings = Math.max(1, Math.floor(siblingCount));

  // Agents left for the whole subtree after this generation is created, split
  // evenly. Floor, so rounding can only ever under-allocate — never breach.
  const eachAllowance = Math.max(0, Math.floor((parent.max_child_count - siblings) / siblings));

  // One share per child, plus one the parent keeps: it still has to pay for the
  // planning run that produced these subgoals and the synthesis run that will
  // combine their answers.
  const share = parent.budget_usd / (siblings + 1);

  // There is no platform-policy concept in the codebase yet (doc §8 describes
  // one, nothing implements it), so the parent's own authority stands in as the
  // platform maximum — raised by an approval when there is one.
  const granted: Authority = approvedBudgetUsd === undefined
    ? parent
    : { ...parent, budget_usd: Math.max(parent.budget_usd, approvedBudgetUsd) };

  const authority = effectiveAuthority(granted, granted, {
    ...granted,
    budget_usd: approvedBudgetUsd ?? share,
    max_child_count: eachAllowance,
    spawn_children: eachAllowance > 0,
  });

  return {
    ...authority,
    // Spawn authority a child could never afford to use only sends it straight
    // to ESCALATE, asking a human to approve the same delegation one generation
    // down. It needs enough for itself and at least one child.
    spawn_children: authority.spawn_children && authority.budget_usd >= MIN_AGENT_BUDGET_USD * 2,
  };
}

export interface DelegateChildDeps {
  /** `siblingCount` rather than a budget: what a child may hold is derived from
   *  its parent and how many ways the work was split, so no caller is in a
   *  position to decide it. */
  createChildNode: (parentId: string, goal: string, siblingCount: number, approvedBudgetUsd?: number) => string;
  recordCommitment: (childId: string, goal: string) => void;
  startChild: (childId: string, goal: string) => void;
  waitForChild: (childId: string) => Promise<{ succeeded: boolean }>;
}

/** Hands each subgoal to its own child and runs them together.
 *
 *  Previously this created one child carrying the parent's goal verbatim, so a
 *  delegating organization was a chain of identical clones, each re-deciding the
 *  same question one generation down. With a real split, siblings work in
 *  parallel on different things — which is the only version of this that is
 *  worth the coordination cost the economics engine charges for it. */
export async function delegateToChildren(
  input: DelegateInput,
  deps: DelegateChildDeps,
): Promise<ExecuteStepResult> {
  // No usable split means no delegation. Handing the child the parent's own
  // goal is the clone case, and it is never the right answer: the parent should
  // do the work itself instead.
  if ((input.existingChildren ?? 0) > 0) {
    return {
      succeeded: false,
      notDelegatable: true,
      message: `This work was already split across ${input.existingChildren} agents. Finishing it directly rather than splitting it a second time.`,
      events: [],
    };
  }

  const subgoals = (input.subgoals ?? []).filter((goal) => goal.trim().length > 0);
  if (subgoals.length === 0) {
    return {
      succeeded: false,
      // Not a failure to retry: retrying re-runs the planner and reaches the
      // same conclusion, at the cost of another sandbox each time. The machine
      // reads this flag and does the work itself instead.
      notDelegatable: true,
      message: 'This goal did not split into independent pieces, so the agent is doing it directly.',
      events: [],
    };
  }

  const children = subgoals.map((goal) => {
    const childId = deps.createChildNode(input.parentId, goal, subgoals.length, input.approvedBudgetUsd);
    deps.recordCommitment(childId, goal);
    deps.startChild(childId, goal);
    return { childId, goal };
  });

  // Siblings run concurrently — waiting for each in turn would make a fan-out
  // take as long as a chain, which is the thing it exists to avoid.
  const results = await Promise.all(
    children.map(async (child) => ({ ...child, ...(await deps.waitForChild(child.childId)) })),
  );

  const failed = results.filter((result) => !result.succeeded);
  return {
    succeeded: failed.length === 0,
    message: failed.length === 0
      ? `All ${results.length} delegated pieces completed`
      : `${failed.length} of ${results.length} delegated pieces did not succeed: ${failed.map((f) => f.goal).join('; ')}`,
    events: [],
  };
}
