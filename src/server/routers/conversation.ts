import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import { getWorkspace } from '../../workspace/repository.js';
import { getProject } from '../../projects/repository.js';
import {
  createConversation,
  getConversation,
  listConversations,
} from '../../conversations/repository.js';

export const conversationRouter = router({
  list: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input, ctx }) => listConversations(ctx.db, input.projectId)),

  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input, ctx }) => {
      const conversation = getConversation(ctx.db, input.id);
      if (!conversation) throw new Error(`Conversation ${input.id} not found`);
      return conversation;
    }),

  create: publicProcedure
    .input(z.object({
      workspaceId: z.string(),
      projectId: z.string().nullable().default(null),
      title: z.string().trim().min(1),
    }))
    .mutation(({ input, ctx }) => {
      if (!getWorkspace(ctx.db, input.workspaceId)) {
        throw new Error(`Workspace ${input.workspaceId} not found`);
      }
      if (input.projectId) {
        const project = getProject(ctx.db, input.projectId);
        if (!project) throw new Error(`Project ${input.projectId} not found`);
        if (project.workspaceId !== input.workspaceId) {
          throw new Error('Project does not belong to the selected workspace');
        }
      }
      const now = new Date().toISOString();
      return createConversation(ctx.db, { id: randomUUID(), ...input, now });
    }),
});
