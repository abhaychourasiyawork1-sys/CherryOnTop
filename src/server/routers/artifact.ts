import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import { listArtifactsForNode, listArtifactsForNodes } from '../../db/queries/artifacts.js';
import { subtreeNodeIds } from '../../db/queries/nodes.js';

export const artifactRouter = router({
  listForNode: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(({ input, ctx }) => listArtifactsForNode(ctx.db, input.nodeId)),

  listForSubtree: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(({ input, ctx }) => listArtifactsForNodes(ctx.db, subtreeNodeIds(ctx.db, input.nodeId))),
});
