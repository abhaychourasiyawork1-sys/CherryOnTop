/** Test fixtures shared by the projection tests. Not imported by the app. */
import type { OrgNode } from './useOrg.js';

export function node(partial: Partial<OrgNode> & { id: string }): OrgNode {
  return {
    parentId: null,
    goal: partial.id,
    state: 'COMPLETE',
    contract: {
      goal: partial.id, definition_of_done: [], constraints: [],
      authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 5 },
    },
    repoPath: '/host/app',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    costUsd: 0,
    budgetHealth: 0,
    childCount: 0,
    needsApproval: false,
    ...partial,
  };
}
