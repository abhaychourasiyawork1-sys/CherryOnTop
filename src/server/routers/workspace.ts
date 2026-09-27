import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import {
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  archiveWorkspace,
} from '../../workspace/repository.js';

const Settings = z.record(z.string(), z.unknown());

export const workspaceRouter = router({
  list: publicProcedure.query(({ ctx }) => listWorkspaces(ctx.db)),

  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input, ctx }) => {
      const workspace = getWorkspace(ctx.db, input.id);
      if (!workspace) throw new Error(`Workspace ${input.id} not found`);
      return workspace;
    }),

  create: publicProcedure
    .input(z.object({
      name: z.string().trim().min(1),
      description: z.string().default(''),
      settings: Settings.default({}),
    }))
    .mutation(({ input, ctx }) => {
      const now = new Date().toISOString();
      return createWorkspace(ctx.db, { id: randomUUID(), ...input, now });
    }),

  archive: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input, ctx }) => {
      if (!getWorkspace(ctx.db, input.id)) throw new Error(`Workspace ${input.id} not found`);
      archiveWorkspace(ctx.db, input.id, new Date().toISOString());
      return { ok: true as const };
    }),
});
