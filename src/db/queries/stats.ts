import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../client.js';
import { nodes, events, approvals } from '../schema.js';
import { subtreeNodeIds } from './nodes.js';

/** The events that carry real money. All three roles dispatch a sandbox and all
 *  three are billed; counting only `exec.result` under-reported every node's
 *  spend by whatever its planning and synthesis runs cost — $0.077 of $2.65 in
 *  the one fully measured run, and the number a budget guard has to trust. */
const COST_EVENTS = ['exec.result', 'plan.result', 'synth.result'];

export interface OrgStats {
  active: number;
  complete: number;
  failed: number;
  cancelled: number;
  totalCostUsd: number;
  /** Approvals still waiting on a human — what the status line reports as
   *  "waiting on you", not everything that was ever escalated. */
  pendingApprovals: number;
}

export function getOrgStats(db: Db): OrgStats {
  const allNodes = db.select().from(nodes).all();
  const complete = allNodes.filter((n) => n.state === 'COMPLETE').length;
  const failed = allNodes.filter((n) => n.state === 'FAILED').length;
  const cancelled = allNodes.filter((n) => n.state === 'CANCELLED').length;
  // Every terminal state subtracts. Deriving `active` by subtraction means a
  // state added later is counted as running until it is listed here — which is
  // exactly what CANCELLED did.
  const active = allNodes.length - complete - failed - cancelled;

  // Real spend, not the budget: only a `result` event from an actual Claude Code
  // run carries what the run cost.
  const resultEvents = db.select().from(events).where(inArray(events.type, COST_EVENTS)).all();
  const totalCostUsd = resultEvents.reduce((sum, e) => {
    const payload = e.payload as { total_cost_usd?: number } | null;
    return sum + (payload?.total_cost_usd ?? 0);
  }, 0);

  const pendingApprovals = db.select().from(approvals).where(eq(approvals.status, 'pending')).all().length;

  return { active, complete, failed, cancelled, totalCostUsd, pendingApprovals };
}

/** What a set of nodes actually spent. Same source as getOrgStats' total — only
 *  a `result` event from a real run carries what the run cost — scoped instead
 *  of global, so a node's budget meter and the org total can never disagree. */
export function getCostForNodes(db: Db, nodeIds: string[]): number {
  if (nodeIds.length === 0) return 0;
  const rows = db.select().from(events)
    .where(and(inArray(events.type, COST_EVENTS), inArray(events.nodeId, nodeIds)))
    .all();
  return rows.reduce((sum, e) => sum + ((e.payload as { total_cost_usd?: number } | null)?.total_cost_usd ?? 0), 0);
}

/** Spend rolled up per node id, including everything delegated beneath it. A
 *  parent that delegated all its work spends nothing directly but is still
 *  accountable for its children's spend against its own budget. */
export function getSubtreeCosts(db: Db): Map<string, number> {
  const direct = new Map<string, number>();
  for (const event of db.select().from(events).where(inArray(events.type, COST_EVENTS)).all()) {
    const cost = (event.payload as { total_cost_usd?: number } | null)?.total_cost_usd ?? 0;
    direct.set(event.nodeId, (direct.get(event.nodeId) ?? 0) + cost);
  }
  const rolled = new Map<string, number>();
  for (const node of db.select().from(nodes).all()) {
    const total = subtreeNodeIds(db, node.id).reduce((sum, id) => sum + (direct.get(id) ?? 0), 0);
    rolled.set(node.id, total);
  }
  return rolled;
}

/** Fraction of a node's authorized budget its subtree has consumed. Over 1 means
 *  the organization spent past what it authorized — visible, not hidden. */
export function budgetHealth(spentUsd: number, budgetUsd: number): number {
  return budgetUsd > 0 ? spentUsd / budgetUsd : 0;
}
