import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import { listEventsForNode } from '../../db/queries/events.js';

export const eventsRouter = router({
  listForNode: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(({ input, ctx }) => listEventsForNode(ctx.db, input.nodeId)),
});
