import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import {
  listSessions, getSession, insertSession, updateSession, deleteSession, sessionMemoryFor,
} from '../../db/queries/sessions.js';

/** Chat sessions: a named thread of runs in one repository. */
export const sessionRouter = router({
  list: publicProcedure.query(({ ctx }) => listSessions(ctx.db)),

  create: publicProcedure
    .input(z.object({ repoPath: z.string().nullable(), title: z.string().default('') }))
    .mutation(({ input, ctx }) => {
      const now = new Date().toISOString();
      const id = randomUUID();
      insertSession(ctx.db, { id, repoPath: input.repoPath, title: input.title.trim() || 'New session', createdAt: now, updatedAt: now });
      return { id };
    }),

  rename: publicProcedure
    .input(z.object({ id: z.string(), title: z.string().trim().min(1) }))
    .mutation(({ input, ctx }) => {
      if (!getSession(ctx.db, input.id)) throw new Error(`Session ${input.id} not found`);
      updateSession(ctx.db, input.id, { title: input.title });
      return { ok: true as const };
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input, ctx }) => {
      deleteSession(ctx.db, input.id);
      return { ok: true as const };
    }),

  /** Exactly what the next message in this session will be told about the
   *  earlier ones — shown in the window so session memory is inspectable. */
  memory: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input, ctx }) => ({ text: sessionMemoryFor(ctx.db, input.id) })),
});
