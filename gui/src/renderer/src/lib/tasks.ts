import type { OrgNode } from './useOrg.js';
import { toneOf, isTerminal, type Tone } from './state.js';

/** A task is one root node and everything it delegated. It is the unit the whole
 *  window is organized around: the rail lists tasks, and both views show one. */
export interface Task {
  id: string;
  goal: string;
  /** The root's own state — what the task as a whole is doing. */
  state: string;
  tone: Tone;
  createdAt: string;
  /** Every node under it, the root included. */
  nodeCount: number;
  /** Spend across the whole task, already rolled up by node.overview. */
  costUsd: number;
  budgetUsd: number;
  /** True if anything anywhere in the task is waiting on a human. */
  needsApproval: boolean;
  running: boolean;
}

function childMap(nodes: OrgNode[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    children.set(node.parentId, [...(children.get(node.parentId) ?? []), node.id]);
  }
  return children;
}

/** Ids of a node and everything beneath it. Mirrors subtreeNodeIds in
 *  src/db/queries/nodes.ts — same walk, over the nodes already in hand, so a
 *  view change costs no round trip. */
export function subtreeIds(nodes: OrgNode[], rootId: string): string[] {
  const children = childMap(nodes);
  const ids: string[] = [];
  const stack = [rootId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    stack.push(...(children.get(id) ?? []));
  }
  return ids;
}

export function subtreeOf(nodes: OrgNode[], rootId: string): OrgNode[] {
  const ids = new Set(subtreeIds(nodes, rootId));
  return nodes.filter((node) => ids.has(node.id));
}

/** How far each node sits below its root. The transcript indents a speaker by
 *  this, which is what makes delegation visible in the shape of the reading. */
export function depths(nodes: OrgNode[]): Map<string, number> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depth = new Map<string, number>();
  const of = (id: string, guard: Set<string>): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    const node = byId.get(id);
    // A node whose parent is not loaded is treated as a root rather than
    // dropped — the same rule the graph layout uses.
    const parentId = node?.parentId;
    const value = !parentId || !byId.has(parentId) || guard.has(id)
      ? 0
      : of(parentId, new Set(guard).add(id)) + 1;
    depth.set(id, value);
    return value;
  };
  for (const node of nodes) of(node.id, new Set());
  return depth;
}

/** The rail's list: newest first, because the task you just gave is the one you
 *  are watching. */
export function toTasks(nodes: OrgNode[]): Task[] {
  const roots = nodes.filter((node) => !node.parentId);
  return roots
    .map((root) => {
      const subtree = subtreeOf(nodes, root.id);
      return {
        id: root.id,
        goal: root.goal,
        state: root.state,
        tone: subtree.some((n) => n.needsApproval) ? ('at-risk' as const) : toneOf(root.state),
        createdAt: root.createdAt,
        nodeCount: subtree.length,
        costUsd: root.costUsd,
        budgetUsd: root.contract.authority.budget_usd,
        needsApproval: subtree.some((n) => n.needsApproval),
        running: !isTerminal(root.state),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
