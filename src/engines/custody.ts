import type { Authority } from '../schemas/node-contract.js';

export interface CustodyHop {
  nodeId: string;
  goal: string;
  authority: Authority;
  /** What this hop lost relative to the one above it. Empty at the root, whose
   *  authority came from a person rather than another agent. */
  narrowed: string[];
}

export interface CustodyChain {
  /** Always begins with the person. An agent's authority has to come from
   *  somewhere, and saying so is the whole point of the chain. */
  origin: 'human';
  hops: CustodyHop[];
}

interface NodeLike {
  id: string;
  parentId: string | null;
  goal: string;
  contract: { authority: Authority };
}

/** What a child was denied relative to its parent.
 *
 *  A smaller budget is not a narrowing — every child gets one, that is
 *  delegation working. What counts is authority a child was actually refused:
 *  it may no longer delegate, or it may reach for fewer tools. */
export function narrowing(parent: Authority, child: Authority): string[] {
  const lost: string[] = [];
  if (parent.spawn_children && !child.spawn_children) lost.push('may no longer delegate');
  else if (child.max_child_count < parent.max_child_count) {
    lost.push(`may build ${child.max_child_count} agents, not ${parent.max_child_count}`);
  }
  const parentTools = new Set(parent.tools);
  const removed = parent.tools.length > 0 ? [...parentTools].filter((t) => !child.tools.includes(t)) : [];
  if (removed.length > 0) lost.push(`lost ${removed.join(', ')}`);
  return lost;
}

/**
 * The path authority took to reach one node: you, then every agent that passed
 * it on, and what each of them gave up along the way.
 *
 * Pure, and deliberately so — this is the object the Receipt has to be able to
 * render for a run that finished months ago, from rows alone.
 */
export function chainOf(nodes: NodeLike[], nodeId: string): CustodyChain {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path: NodeLike[] = [];
  let current = byId.get(nodeId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return {
    origin: 'human',
    hops: path.map((node, index) => ({
      nodeId: node.id,
      goal: node.goal,
      authority: node.contract.authority,
      narrowed: index === 0
        ? []
        : narrowing(path[index - 1].contract.authority, node.contract.authority),
    })),
  };
}
