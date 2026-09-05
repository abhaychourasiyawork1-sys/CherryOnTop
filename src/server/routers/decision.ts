import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import { listDecisionsForNode } from '../../db/queries/decisions.js';

export const decisionRouter = router({
  listForNode: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(({ input, ctx }) => listDecisionsForNode(ctx.db, input.nodeId)),
});
