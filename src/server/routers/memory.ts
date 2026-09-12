import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import { getRuntimeStats, listMemory, setOutcomeVetoed, VETOED_KIND, type RunOutcome } from '../../db/queries/memory.js';
import { getNode } from '../../db/queries/nodes.js';
import { tokensByRole } from '../../db/queries/tokens.js';

export const memoryRouter = router({
  /** What the organization has learned about each runtime it has actually used. */
  runtimeStats: publicProcedure.query(({ ctx }) => getRuntimeStats(ctx.db)),

  /** Every claim the organization makes about itself, with the runs behind it.
   *
   *  A statistic with no way to see what it is made of is an assertion. This is
   *  the same aggregate the runtime selects with, plus the observations that
   *  produced it and whether a person has excluded any of them. */
  claims: publicProcedure.query(({ ctx }) => {
    const counted = listMemory(ctx.db, 'run_outcome');
    const vetoed = listMemory(ctx.db, VETOED_KIND);
    const evidence = (runtime: string, rows: typeof counted) =>
      rows.filter((row) => row.key === runtime)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((row) => ({
          id: row.id,
          nodeId: row.nodeId,
          goal: row.nodeId ? getNode(ctx.db, row.nodeId)?.goal ?? null : null,
          outcome: row.value as RunOutcome,
          createdAt: row.createdAt,
        }));

    return getRuntimeStats(ctx.db).map((stat) => ({
      ...stat,
      // Sample size is the honest confidence signal here, so it is stated as
      // one rather than dressed up as a probability we have not earned.
      basis: evidence(stat.runtime, counted),
      excluded: evidence(stat.runtime, vetoed),
    }));
  }),

  /** Excludes or restores one observation. A person overruling the evidence is
   *  itself part of the record, which is why nothing is deleted. */
  veto: publicProcedure
    .input(z.object({ id: z.string(), vetoed: z.boolean() }))
    .mutation(({ input, ctx }) => {
      setOutcomeVetoed(ctx.db, input.id, input.vetoed);
      return { ok: true as const };
    }),

  recent: publicProcedure
    .input(z.object({ kind: z.string().optional(), limit: z.number().min(1).max(500).default(100) }))
    .query(({ input, ctx }) =>
      listMemory(ctx.db, input.kind)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, input.limit),
    ),

  tokens: publicProcedure
    .input(z.object({ caseId: z.string().optional() }).optional())
    .query(({ input, ctx }) => tokensByRole(ctx.db, input?.caseId)),
});
