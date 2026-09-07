import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import { AuthoritySchema } from '../../schemas/node-contract.js';
import {
  listMandates, getMandate, insertMandate, updateMandate, deleteMandate,
} from '../../db/queries/mandates.js';
import { simulateAuthority, summarizeAuthority } from '../../engines/simulate-authority.js';

const Body = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  authority: AuthoritySchema,
  constraints: z.array(z.string()).default([]),
});

export const mandateRouter = router({
  list: publicProcedure.query(({ ctx }) =>
    listMandates(ctx.db).map((mandate) => ({
      ...mandate,
      summary: summarizeAuthority({ authority: mandate.authority, constraints: mandate.constraints }),
    })),
  ),

  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input, ctx }) => {
      const mandate = getMandate(ctx.db, input.id);
      if (!mandate) throw new Error(`Mandate ${input.id} not found`);
      return mandate;
    }),

  /** What a contract permits, before anything runs. A query with no side
   *  effects and no model call — the whole point is that knowing the blast
   *  radius is free. */
  simulate: publicProcedure
    .input(z.object({ authority: AuthoritySchema, constraints: z.array(z.string()).default([]) }))
    .query(({ input }) => ({
      envelope: simulateAuthority(input),
      summary: summarizeAuthority(input),
    })),

  create: publicProcedure.input(Body).mutation(({ input, ctx }) => {
    const now = new Date().toISOString();
    const id = randomUUID();
    insertMandate(ctx.db, { id, ...input, builtin: false, createdAt: now, updatedAt: now });
    return { id };
  }),

  update: publicProcedure
    .input(Body.partial().extend({ id: z.string() }))
    .mutation(({ input, ctx }) => {
      const { id, ...patch } = input;
      if (!getMandate(ctx.db, id)) throw new Error(`Mandate ${id} not found`);
      updateMandate(ctx.db, id, patch, new Date().toISOString());
      return { ok: true as const };
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input, ctx }) => {
      deleteMandate(ctx.db, input.id);
      return { ok: true as const };
    }),
});
