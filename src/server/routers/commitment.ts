import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import { listCommitmentsForNode } from '../../db/queries/commitments.js';

export const commitmentRouter = router({
  listForNode: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(({ input, ctx }) => listCommitmentsForNode(ctx.db, input.nodeId)),
});
