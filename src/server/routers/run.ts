import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import { getConversation } from '../../conversations/repository.js';
import { getNode } from '../../db/queries/nodes.js';
import {
  createRun,
  getRun,
  listRuns,
} from '../../runs/repository.js';

export const runRouter = router({
  list: publicProcedure
    .input(z.object({ conversationId: z.string() }))
    .query(({ input, ctx }) => listRuns(ctx.db, input.conversationId)),

  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input, ctx }) => {
      const run = getRun(ctx.db, input.id);
      if (!run) throw new Error(`Run ${input.id} not found`);
      return run;
    }),

  create: publicProcedure
    .input(z.object({
      conversationId: z.string(),
      caseId: z.string(),
      goal: z.string().trim().min(1),
      mandateSnapshot: z.record(z.string(), z.unknown()).default({}),
    }))
    .mutation(({ input, ctx }) => {
      if (!getConversation(ctx.db, input.conversationId)) {
        throw new Error(`Conversation ${input.conversationId} not found`);
      }
      if (!getNode(ctx.db, input.caseId)) {
        throw new Error(`Root case/node ${input.caseId} not found`);
      }
      const now = new Date().toISOString();
      return createRun(ctx.db, { id: randomUUID(), ...input, now });
    }),
});
