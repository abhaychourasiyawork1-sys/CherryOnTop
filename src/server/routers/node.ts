import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import { NodeContractSchema } from '../../schemas/node-contract.js';
import { insertNode, getNode, listNodes } from '../../db/queries/nodes.js';
import { getNodeActor, sendToNode } from '../../lifecycle/node-actor-manager.js';
import { resolveApproval, getApproval } from '../../db/queries/approvals.js';
import { insertCommitment } from '../../db/queries/commitments.js';

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
      // A root node owns a commitment just as a delegated child does — otherwise
      // `org commitment <id>` is empty for the only id `org run` hands back.
      insertCommitment(ctx.db, {
        id: randomUUID(), owner: id, goal: input.goal,
        definition_of_done: input.definition_of_done,
        status: 'pending', created_at: now,
        dependencies: [], evidence: [], risks: [],
      }, now);
      ctx.startNode(ctx.db, id, input.goal);
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
      if (approval.status !== 'pending') {
        throw new Error(`Approval ${input.approvalId} was already ${approval.status}`);
      }
      // Notify first, resolve second. The actor registry is in-process, so a daemon
      // restart since the escalation leaves no actor to send to — burning the
      // approval row before finding that out would strand the node in
      // WAIT_APPROVAL with no second chance to approve it.
      if (!getNodeActor(approval.nodeId)) {
        throw new Error(`Node ${approval.nodeId} has no active actor — it did not survive a daemon restart`);
      }
      sendToNode(approval.nodeId, { type: input.decision === 'approved' ? 'APPROVED' : 'REJECTED' });
      resolveApproval(ctx.db, input.approvalId, input.decision, new Date().toISOString());
      return { ok: true as const };
    }),
});
