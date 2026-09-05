import type { ExecuteStepResult } from '../execution/execute-step.js';

export interface DelegateInput {
  parentId: string;
  goal: string;
  childBudgetUsd: number;
}

export interface DelegateChildDeps {
  createChildNode: (parentId: string, goal: string, budgetUsd: number) => string;
  recordCommitment: (childId: string, goal: string) => void;
  startChild: (childId: string, goal: string) => void;
  waitForChild: (childId: string) => Promise<{ succeeded: boolean }>;
}

export async function delegateToChild(
  input: DelegateInput,
  deps: DelegateChildDeps,
): Promise<ExecuteStepResult> {
  const childId = deps.createChildNode(input.parentId, input.goal, input.childBudgetUsd);
  deps.recordCommitment(childId, input.goal);
  deps.startChild(childId, input.goal);
  const result = await deps.waitForChild(childId);
  return {
    succeeded: result.succeeded,
    message: result.succeeded ? `Child ${childId} completed` : `Child ${childId} did not succeed`,
    events: [],
  };
}
