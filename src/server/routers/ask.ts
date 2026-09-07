import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import { parseQuestion } from '../../intelligence/ask.js';
import { listNodes, getNode, subtreeNodeIds } from '../../db/queries/nodes.js';
import { listDecisionsForNode } from '../../db/queries/decisions.js';
import { listArtifactsForNode } from '../../db/queries/artifacts.js';
import { listPendingApprovals } from '../../db/queries/approvals.js';
import { getCostForNodes, getOrgStats } from '../../db/queries/stats.js';

const TERMINAL = ['COMPLETE', 'FAILED', 'CANCELLED'];

export const askRouter = router({
  /** Answers from the record, never from a model. Every field returned is a row
   *  the runtime already wrote, so "show me the evidence" is the evidence rather
   *  than a description of it. */
  ask: publicProcedure
    .input(z.object({
      question: z.string(),
      /** The node the asker is looking at. "Why did you do that?" is asked
       *  about something already on screen far more often than about a uuid
       *  typed from memory, so a named id wins and this is the fallback. */
      focusedNodeId: z.string().optional(),
    }))
    .query(({ input, ctx }) => {
      const { intent, nodeId: prefix } = parseQuestion(input.question);
      const all = listNodes(ctx.db);
      const node = prefix
        ? all.find((n) => n.id === prefix || n.id.startsWith(prefix)) ?? null
        : all.find((n) => n.id === input.focusedNodeId) ?? null;

      if (intent === 'why') {
        if (!node) return { intent, answer: 'Select a node first, then ask why.' as const, decisions: [] };
        const decisions = listDecisionsForNode(ctx.db, node.id);
        return {
          intent, nodeId: node.id, goal: node.goal, decisions,
          answer: decisions.length === 0
            ? 'This node has not made a scored decision yet.'
            : `${decisions.length} scored ${decisions.length === 1 ? 'decision' : 'decisions'}.`,
        };
      }

      if (intent === 'blocking') {
        const pending = listPendingApprovals(ctx.db);
        const scope = node ? subtreeNodeIds(ctx.db, node.id) : null;
        const relevant = scope ? pending.filter((a) => scope.includes(a.nodeId)) : pending;
        if (relevant.length > 0) {
          return { intent, blockedBy: 'approval' as const, approvals: relevant,
            answer: `${relevant.length} ${relevant.length === 1 ? 'approval is' : 'approvals are'} waiting on you.` };
        }
        // Nothing needs a human — then what is blocking is simply the deepest
        // thing still running, which is the honest answer.
        const running = (scope ? all.filter((n) => scope.includes(n.id)) : all)
          .filter((n) => !TERMINAL.includes(n.state));
        return {
          intent,
          blockedBy: running.length > 0 ? ('work' as const) : ('nothing' as const),
          nodes: running,
          answer: running.length > 0
            ? `Nothing needs you. ${running.length} ${running.length === 1 ? 'node is' : 'nodes are'} still working.`
            : 'Nothing is blocked — everything has finished.',
        };
      }

      if (intent === 'cost') {
        if (node) {
          const costUsd = getCostForNodes(ctx.db, subtreeNodeIds(ctx.db, node.id));
          return { intent, nodeId: node.id, goal: node.goal, costUsd,
            budgetUsd: node.contract.authority.budget_usd,
            answer: `$${costUsd.toFixed(4)} of $${node.contract.authority.budget_usd.toFixed(2)} authorized.` };
        }
        const stats = getOrgStats(ctx.db);
        return { intent, costUsd: stats.totalCostUsd,
          answer: `$${stats.totalCostUsd.toFixed(4)} across every run.` };
      }

      if (intent === 'evidence') {
        if (!node) return { intent, answer: 'Select a node first, then ask what it produced.' as const, artifacts: [] };
        const artifacts = listArtifactsForNode(ctx.db, node.id);
        return { intent, nodeId: node.id, goal: node.goal, artifacts,
          answer: artifacts.length === 0
            ? 'This node has not produced anything yet.'
            : `${artifacts.length} ${artifacts.length === 1 ? 'artifact' : 'artifacts'}.` };
      }

      return {
        intent: 'unknown' as const,
        answer: 'That is not something the record can answer.',
        // What it *can* answer, so the caller can offer it rather than guess.
        supported: ['why <id>', 'what is blocking <id>', 'cost [id]', 'evidence <id>'],
      };
    }),
});
