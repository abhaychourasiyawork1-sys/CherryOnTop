import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import { getWorkspace } from '../../workspace/repository.js';
import {
  createProject,
  getProject,
  listProjects,
} from '../../projects/repository.js';

const Settings = z.record(z.string(), z.unknown());

export const projectRouter = router({
  list: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(({ input, ctx }) => listProjects(ctx.db, input.workspaceId)),

  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input, ctx }) => {
      const project = getProject(ctx.db, input.id);
      if (!project) throw new Error(`Project ${input.id} not found`);
      return project;
    }),

  create: publicProcedure
    .input(z.object({
      workspaceId: z.string(),
      name: z.string().trim().min(1),
      description: z.string().default(''),
      settings: Settings.default({}),
    }))
    .mutation(({ input, ctx }) => {
      if (!getWorkspace(ctx.db, input.workspaceId)) {
        throw new Error(`Workspace ${input.workspaceId} not found`);
      }
      const now = new Date().toISOString();
      return createProject(ctx.db, { id: randomUUID(), ...input, now });
    }),
});
