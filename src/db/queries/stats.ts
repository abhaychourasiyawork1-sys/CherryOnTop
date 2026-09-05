import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { nodes, events } from '../schema.js';

export interface OrgStats {
  active: number;
  complete: number;
  failed: number;
  totalCostUsd: number;
}

export function getOrgStats(db: Db): OrgStats {
  const allNodes = db.select().from(nodes).all();
  const complete = allNodes.filter((n) => n.state === 'COMPLETE').length;
  const failed = allNodes.filter((n) => n.state === 'FAILED').length;
  const active = allNodes.length - complete - failed;

  // Real spend, not the budget: only a `result` event from an actual Claude Code
  // run carries what the run cost.
  const resultEvents = db.select().from(events).where(eq(events.type, 'exec.result')).all();
  const totalCostUsd = resultEvents.reduce((sum, e) => {
    const payload = e.payload as { total_cost_usd?: number } | null;
    return sum + (payload?.total_cost_usd ?? 0);
  }, 0);

  return { active, complete, failed, totalCostUsd };
}
