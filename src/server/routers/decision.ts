import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import { listDecisionsForNode } from '../../db/queries/decisions.js';
import { replayNode } from '../../efficiency/replay.js';

export const decisionRouter = router({
  listForNode: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(({ input, ctx }) => listDecisionsForNode(ctx.db, input.nodeId)),

  /** Re-runs this node's recorded decisions through the same arithmetic that
   *  produced them, and reports whether today's code still agrees. Free — the
   *  decisions were formulas, not model calls — which is what makes checking
   *  the audit trail something you can actually do rather than something the
   *  design merely promises. */
  replay: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(({ input, ctx }) => replayNode(input.nodeId, listDecisionsForNode(ctx.db, input.nodeId))),
});
