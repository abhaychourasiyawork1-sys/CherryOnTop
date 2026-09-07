import type { OrgNode } from './useOrg.js';
import type { OrgEvent } from './eventLog.js';

export interface Moment {
  /** Nodes as they were, with the state and spend they had at that instant.
   *  A node created after the moment is absent, not greyed out — it did not
   *  exist yet, and drawing it would be inventing history. */
  nodes: OrgNode[];
  awaitingNodeIds: Set<string>;
  costUsd: number;
  at: string;
}

/** Timestamps the scrubber can stop on: every moment the organization actually
 *  changed. Stepping through wall-clock instead would spend most of the track on
 *  nothing happening. */
export function momentsOf(events: OrgEvent[]): string[] {
  const interesting = events.filter((event) =>
    event.type === 'state.transition' || event.type === 'exec.result' ||
    event.type === 'decision.made' || event.type === 'authority.denied');
  return [...new Set(interesting.map((event) => event.createdAt))].sort();
}

/**
 * The organization as it stood at one instant, rebuilt from the event log.
 *
 * Only possible because events are append-only and timestamped — this needs no
 * new storage at all, which is why a feature that looks expensive is not.
 */
export function projectTo(nodes: OrgNode[], events: OrgEvent[], at: string): Moment {
  const upTo = events.filter((event) => event.createdAt <= at);

  const stateAt = new Map<string, string>();
  const spentBy = new Map<string, number>();
  const awaiting = new Set<string>();

  for (const event of upTo) {
    if (event.type === 'state.transition') {
      const state = (event.payload as { state?: unknown } | null)?.state;
      if (typeof state === 'string') stateAt.set(event.nodeId, state);
      // Leaving WAIT_APPROVAL is the only thing that clears the block; the
      // approval row itself has no event of its own.
      if (state === 'WAIT_APPROVAL') awaiting.add(event.nodeId);
      else awaiting.delete(event.nodeId);
    }
    if (event.type === 'exec.result') {
      const cost = (event.payload as { total_cost_usd?: number } | null)?.total_cost_usd ?? 0;
      spentBy.set(event.nodeId, (spentBy.get(event.nodeId) ?? 0) + cost);
    }
  }

  const present = nodes.filter((node) => node.createdAt <= at);
  const byId = new Map(present.map((node) => [node.id, node]));

  // Spend rolls up, exactly as it does live: a parent that delegated everything
  // spends nothing itself but is still accountable for what its children spent.
  const rolled = (id: string, seen = new Set<string>()): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    const own = spentBy.get(id) ?? 0;
    const children = present.filter((node) => node.parentId === id);
    return own + children.reduce((sum, child) => sum + rolled(child.id, seen), 0);
  };

  const projected = present.map((node) => {
    const costUsd = rolled(node.id);
    const budget = node.contract.authority.budget_usd;
    return {
      ...node,
      state: stateAt.get(node.id) ?? 'CREATED',
      costUsd,
      budgetHealth: budget > 0 ? costUsd / budget : 0,
      childCount: present.filter((child) => child.parentId === node.id).length,
      needsApproval: awaiting.has(node.id),
    };
  });

  return {
    nodes: projected,
    awaitingNodeIds: awaiting,
    costUsd: projected.filter((node) => !node.parentId).reduce((sum, node) => sum + node.costUsd, 0),
    at,
  };
}
