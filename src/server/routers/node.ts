import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import { NodeContractSchema } from '../../schemas/node-contract.js';
import { insertNode, getNode, listNodes } from '../../db/queries/nodes.js';
import { startNodeActor, sendToNode } from '../../lifecycle/node-actor-manager.js';
import { resolveApproval, getApproval } from '../../db/queries/approvals.js';

export const nodeRouter = router({
  create: publicProcedure
    .input(NodeContractSchema)
    .mutation(({ input, ctx }) => {
      const id = randomUUID();
      const now = new Date().toISOString();
      insertNode(ctx.db, {
        id, parentId: null, goal: input.goal, contract: input,
        state: 'CREATED', createdAt: now, updatedAt: now,
      });
      startNodeActor(ctx.db, id, input.goal);
      return { id };
    }),

  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input, ctx }) => {
      const node = getNode(ctx.db, input.id);
      if (!node) throw new Error(`Node ${input.id} not found`);
      return node;
    }),

  tree: publicProcedure.query(({ ctx }) => listNodes(ctx.db)),

  resolveApproval: publicProcedure
    .input(z.object({ approvalId: z.string(), decision: z.enum(['approved', 'rejected']) }))
    .mutation(({ input, ctx }) => {
      // The approval record knows its nodeId — look it up rather than requiring
      // the caller to pass both, since `org approve <id>` only has the id.
      const approval = getApproval(ctx.db, input.approvalId);
      if (!approval) throw new Error(`Approval ${input.approvalId} not found`);
      resolveApproval(ctx.db, input.approvalId, input.decision, new Date().toISOString());
      sendToNode(approval.nodeId, { type: input.decision === 'approved' ? 'APPROVED' : 'REJECTED' });
      return { ok: true as const };
    }),
});
