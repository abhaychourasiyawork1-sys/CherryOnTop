import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import { getApproval, listPendingApprovals } from '../../db/queries/approvals.js';
import { getNode } from '../../db/queries/nodes.js';
import { listDecisionsForNode } from '../../db/queries/decisions.js';
import { getSubtreeCosts } from '../../db/queries/stats.js';

export const approvalRouter = router({
  listPending: publicProcedure.query(({ ctx }) => listPendingApprovals(ctx.db)),

  /** Everything a human needs to answer an approval without leaving it: who is
   *  asking, what authority they want, the scored decision that ran them into
   *  the boundary, and what has already been spent under them. */
  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input, ctx }) => {
      const approval = getApproval(ctx.db, input.id);
      if (!approval) throw new Error(`Approval ${input.id} not found`);
      const node = getNode(ctx.db, approval.nodeId);
      const decisions = listDecisionsForNode(ctx.db, approval.nodeId);
      // The escalation is always the most recent decision — it is what parked
      // the node here.
      const trigger = decisions.at(-1) ?? null;
      const requestedUsd = Number(trigger?.breakdown.requiredBudget ?? 0);
      const availableUsd = Number(
        trigger?.breakdown.availableBudget ?? node?.contract.authority.budget_usd ?? 0,
      );
      return {
        approval,
        node: node ?? null,
        trigger,
        requestedUsd,
        availableUsd,
        spentUsd: node ? (getSubtreeCosts(ctx.db).get(node.id) ?? 0) : 0,
      };
    }),
});
