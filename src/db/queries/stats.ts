import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { nodes, events, approvals } from '../schema.js';

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
  const resultEvents = db.select().from(events).where(eq(events.type, 'exec.result')).all();
  const totalCostUsd = resultEvents.reduce((sum, e) => {
    const payload = e.payload as { total_cost_usd?: number } | null;
    return sum + (payload?.total_cost_usd ?? 0);
  }, 0);

  const pendingApprovals = db.select().from(approvals).where(eq(approvals.status, 'pending')).all().length;

  return { active, complete, failed, cancelled, totalCostUsd, pendingApprovals };
}
