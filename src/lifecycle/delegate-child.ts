import type { ExecuteStepResult } from '../execution/execute-step.js';
import type { Authority } from '../schemas/node-contract.js';
import { effectiveAuthority } from '../engines/authority.js';
import { CHILD_BUDGET_USD } from '../engines/decide-execution.js';

export interface DelegateInput {
  parentId: string;
  goal: string;
  childBudgetUsd: number;
  approvedBudgetUsd?: number;
}

/**
 * The authority a child is created with. Pure, so the two rules that keep
 * delegation from running away are testable without a DB or an actor system:
 *  - each generation spends one of max_child_count, so depth is bounded;
 *  - a child never gets spawn authority its effective budget cannot fund, which
 *    would send it straight to ESCALATE and ask a human to approve the same
 *    delegation one generation down.
 * `approvedBudgetUsd`, when set, is a human's explicit grant and is the one thing
 * that may exceed the parent's own budget.
 */
export function childAuthority(
  parent: Authority,
  budgetUsd: number,
  approvedBudgetUsd?: number,
): Authority {
  const remainingChildren = Math.max(parent.max_child_count - 1, 0);
  // There is no platform-policy concept in the codebase yet (doc §8 describes
  // one, nothing implements it), so the parent's own authority stands in as the
  // platform maximum — raised by an approval when there is one.
  const granted: Authority = approvedBudgetUsd === undefined
    ? parent
    : { ...parent, budget_usd: Math.max(parent.budget_usd, approvedBudgetUsd) };

  const authority = effectiveAuthority(granted, granted, {
    ...granted,
    budget_usd: approvedBudgetUsd ?? budgetUsd,
    max_child_count: remainingChildren,
    spawn_children: remainingChildren > 0,
  });

  return {
    ...authority,
    spawn_children: authority.spawn_children && authority.budget_usd >= CHILD_BUDGET_USD,
  };
}

export interface DelegateChildDeps {
  createChildNode: (parentId: string, goal: string, budgetUsd: number, approvedBudgetUsd?: number) => string;
  recordCommitment: (childId: string, goal: string) => void;
  startChild: (childId: string, goal: string) => void;
  waitForChild: (childId: string) => Promise<{ succeeded: boolean }>;
}

export async function delegateToChild(
  input: DelegateInput,
  deps: DelegateChildDeps,
): Promise<ExecuteStepResult> {
  const childId = deps.createChildNode(input.parentId, input.goal, input.childBudgetUsd, input.approvedBudgetUsd);
  deps.recordCommitment(childId, input.goal);
  deps.startChild(childId, input.goal);
  const result = await deps.waitForChild(childId);
  return {
    succeeded: result.succeeded,
    message: result.succeeded ? `Child ${childId} completed` : `Child ${childId} did not succeed`,
    events: [],
  };
}
