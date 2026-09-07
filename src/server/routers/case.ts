import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import { listCases, caseFacets, listAttention } from '../../db/queries/cases.js';
import { getNode, subtreeNodeIds, listNodes } from '../../db/queries/nodes.js';
import { listDodForNode, dodProgress } from '../../db/queries/dod.js';
import { listArtifactsForNodes } from '../../db/queries/artifacts.js';
import { listDecisionsForNode } from '../../db/queries/decisions.js';
import { listCommitmentsForNode } from '../../db/queries/commitments.js';
import { getCostForNodes, budgetHealth } from '../../db/queries/stats.js';
import { getMandate } from '../../db/queries/mandates.js';
import { simulateAuthority, summarizeAuthority } from '../../engines/simulate-authority.js';
import { chainOf } from '../../engines/custody.js';
import { answerOf } from '../../db/queries/answers.js';
import { listEventsForNodes } from '../../db/queries/events.js';
import { approvalsForNodes } from '../../db/queries/approvals.js';

const Outcome = z.enum(['running', 'waiting', 'interrupted', 'complete', 'failed', 'cancelled']);

export const caseRouter = router({
  list: publicProcedure
    .input(z.object({
      search: z.string().optional(),
      outcomes: z.array(Outcome).optional(),
      mandateIds: z.array(z.string()).optional(),
      runtimes: z.array(z.string()).optional(),
      repoPaths: z.array(z.string()).optional(),
      dod: z.enum(['met', 'outstanding']).optional(),
      intervened: z.boolean().optional(),
      minCostUsd: z.number().optional(),
      maxCostUsd: z.number().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
    }).default({}))
    .query(({ input, ctx }) => listCases(ctx.db, input)),

  facets: publicProcedure.query(({ ctx }) => caseFacets(ctx.db)),

  /** What needs a person, ranked. The Desk reads exactly this. */
  attention: publicProcedure.query(({ ctx }) => listAttention(ctx.db)),

  /** The Case File header: everything a stakeholder needs before any transcript.
   *  One round trip, so state and spend can never come from different reads. */
  file: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input, ctx }) => {
      const root = getNode(ctx.db, input.id);
      if (!root) throw new Error(`Case ${input.id} not found`);
      const subtree = subtreeNodeIds(ctx.db, root.id);
      const costUsd = getCostForNodes(ctx.db, subtree);
      const items = subtree.flatMap((id) => listDodForNode(ctx.db, id));
      const mandate = root.mandateId ? getMandate(ctx.db, root.mandateId) ?? null : null;

      return {
        node: root,
        mandate,
        envelope: simulateAuthority(root.contract),
        summary: summarizeAuthority(root.contract),
        agents: subtree.length,
        costUsd,
        budgetUsd: root.contract.authority.budget_usd,
        budgetHealth: budgetHealth(costUsd, root.contract.authority.budget_usd),
        dod: { items, progress: dodProgress(items) },
        artifacts: listArtifactsForNodes(ctx.db, subtree),
        approvals: approvalsForNodes(ctx.db, subtree),
        answer: answerOf(ctx.db, root.id) || null,
      };
    }),

  /** The chain of custody for one node: you, then every hand the authority
   *  passed through to reach it, and what each hop narrowed. */
  custody: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .query(({ input, ctx }) => chainOf(listNodes(ctx.db), input.nodeId)),

  /** Everything a Receipt renders, in one call, so the exported file cannot be
   *  half from one read and half from another. */
  receipt: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input, ctx }) => {
      const root = getNode(ctx.db, input.id);
      if (!root) throw new Error(`Case ${input.id} not found`);
      const subtree = subtreeNodeIds(ctx.db, root.id);
      const nodes = listNodes(ctx.db).filter((n) => subtree.includes(n.id));
      const items = subtree.flatMap((id) => listDodForNode(ctx.db, id));
      const costUsd = getCostForNodes(ctx.db, subtree);

      return {
        node: root,
        nodes,
        mandate: root.mandateId ? getMandate(ctx.db, root.mandateId) ?? null : null,
        envelope: simulateAuthority(root.contract),
        custody: nodes.map((n) => ({ nodeId: n.id, chain: chainOf(nodes, n.id) })),
        decisions: subtree.flatMap((id) =>
          listDecisionsForNode(ctx.db, id).map((d) => ({ ...d, nodeId: id }))),
        commitments: subtree.flatMap((id) => listCommitmentsForNode(ctx.db, id)),
        dod: { items, progress: dodProgress(items) },
        artifacts: listArtifactsForNodes(ctx.db, subtree),
        approvals: approvalsForNodes(ctx.db, subtree),
        denials: listEventsForNodes(ctx.db, subtree)
          .filter((e) => e.type === 'authority.denied'),
        costUsd,
        budgetUsd: root.contract.authority.budget_usd,
        answer: answerOf(ctx.db, root.id) || null,
        generatedAt: new Date().toISOString(),
      };
    }),
});
