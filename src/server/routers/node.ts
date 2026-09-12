import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { router, publicProcedure } from '../trpc.js';
import { NodeContractSchema } from '../../schemas/node-contract.js';
import { insertNode, getNode, listNodes } from '../../db/queries/nodes.js';
import { insertCommitment } from '../../db/queries/commitments.js';
import { getNodeActor, sendToNode, cancelNode, cancelSubtree } from '../../lifecycle/node-actor-manager.js';
import { resolveApproval, getApproval, getPendingApproval, listPendingApprovals } from '../../db/queries/approvals.js';
import { getSubtreeCosts, getCostForNodes, budgetHealth } from '../../db/queries/stats.js';
import { subtreeNodeIds } from '../../db/queries/nodes.js';
import { listArtifactsForNode } from '../../db/queries/artifacts.js';
import { executionGraph, readyNodes, blockedNodes, graphSummary } from '../../execution/graph.js';
import { listDecisionsForNode } from '../../db/queries/decisions.js';
import { answerOf } from '../../db/queries/answers.js';
import { listCommitmentsForNode } from '../../db/queries/commitments.js';
import { getMandate } from '../../db/queries/mandates.js';
import { insertDodItems, listDodForNode, setDodState, dodProgress } from '../../db/queries/dod.js';
import { resumeNode } from '../../lifecycle/rehydrate.js';
import { simulateAuthority, summarizeAuthority } from '../../engines/simulate-authority.js';
import { setNodeMandate } from '../../db/queries/nodes.js';

export const nodeRouter = router({
  create: publicProcedure
    .input(NodeContractSchema.extend({
      repoPath: z.string().nullable().default(null),
      /** The mandate this run is authored from. Its authority and constraints
       *  replace whatever the caller sent, so a run can never claim to be under
       *  a mandate while quietly holding different authority. */
      mandateId: z.string().nullable().default(null),
    }))
    .mutation(({ input, ctx }) => {
      // repoPath is operational plumbing, not part of the conceptual goal
      // contract — persisting it inside the contract JSON too would just be the
      // same fact in two places to keep in sync.
      const { repoPath, mandateId, ...requested } = input;
      const mandate = mandateId ? getMandate(ctx.db, mandateId) : undefined;
      if (mandateId && !mandate) throw new Error(`Mandate ${mandateId} not found`);
      // The contract is snapshotted here and never read from the mandate again.
      // Editing a mandate tomorrow must not rewrite what this run was permitted
      // to do today — that would make the record unfalsifiable.
      const contract = mandate
        ? { ...requested, authority: mandate.authority, constraints: mandate.constraints }
        : requested;
      const id = randomUUID();
      const now = new Date().toISOString();
      insertNode(ctx.db, {
        id, parentId: null, goal: contract.goal, contract,
        state: 'CREATED', repoPath, mandateId: mandate?.id ?? null,
        snapshot: null, createdAt: now, updatedAt: now,
      });
      // Each promised check becomes a row that can be closed against evidence,
      // rather than a string in a list nothing ever verifies.
      insertDodItems(ctx.db, id, contract.definition_of_done, now, () => randomUUID());
      // A root node owns a commitment just as a delegated child does — otherwise
      // `org commitment <id>` is empty for the only id `org run` hands back.
      insertCommitment(ctx.db, {
        id: randomUUID(), owner: id, goal: input.goal,
        definition_of_done: input.definition_of_done,
        status: 'pending', created_at: now,
        dependencies: [], evidence: [], risks: [],
      }, now);
      ctx.startNode(ctx.db, id, input.goal);
      return { id };
    }),

  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input, ctx }) => {
      const node = getNode(ctx.db, input.id);
      if (!node) throw new Error(`Node ${input.id} not found`);
      return node;
    }),

  /** Everything the inspector shows about one node, in one round trip: the
   *  contract it is accountable for, what it decided and why, what it produced,
   *  what it spent, who it delegated to, and whether it is waiting on a human. */
  detail: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input, ctx }) => {
      const node = getNode(ctx.db, input.id);
      if (!node) throw new Error(`Node ${input.id} not found`);
      const subtree = subtreeNodeIds(ctx.db, node.id);
      const costUsd = getCostForNodes(ctx.db, subtree);
      return {
        node,
        commitments: listCommitmentsForNode(ctx.db, node.id),
        decisions: listDecisionsForNode(ctx.db, node.id),
        artifacts: listArtifactsForNode(ctx.db, node.id),
        children: listNodes(ctx.db).filter((n) => n.parentId === node.id),
        costUsd,
        budgetHealth: budgetHealth(costUsd, node.contract.authority.budget_usd),
        pendingApproval: getPendingApproval(ctx.db, node.id) ?? null,
        dod: (() => {
          const items = listDodForNode(ctx.db, node.id);
          return { items, progress: dodProgress(items) };
        })(),
        envelope: simulateAuthority(node.contract),
        summary: summarizeAuthority(node.contract),
        /** What this node is accountable for having answered. For a delegating
         *  node it is the combined answer; for one that did the work itself it
         *  is its own final report. */
        answer: answerOf(ctx.db, node.id) || null,
      };
    }),

  tree: publicProcedure.query(({ ctx }) => listNodes(ctx.db)),

  /** The tree plus everything the graph draws with it — spend rolled up through
   *  each subtree, budget health, child count, and whether a node is waiting on
   *  a human. One round trip, so a card can never show a state from one read and
   *  a cost from another. */
  overview: publicProcedure.query(({ ctx }) => {
    const all = listNodes(ctx.db);
    const costs = getSubtreeCosts(ctx.db);
    const awaiting = new Set(listPendingApprovals(ctx.db).map((a) => a.nodeId));
    const childCounts = new Map<string, number>();
    for (const node of all) {
      if (node.parentId) childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1);
    }
    return all.map((node) => {
      const costUsd = costs.get(node.id) ?? 0;
      return {
        ...node,
        costUsd,
        budgetHealth: budgetHealth(costUsd, node.contract.authority.budget_usd),
        childCount: childCounts.get(node.id) ?? 0,
        needsApproval: awaiting.has(node.id),
      };
    });
  }),

  listPendingApprovals: publicProcedure.query(({ ctx }) => listPendingApprovals(ctx.db)),

  cancel: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await cancelNode(ctx.db, input.nodeId);
      return { ok: true as const };
    }),

  /** Runs a finished case again under a different mandate, and links the two.
   *
   *  Not a re-execution of the old run: it is a new one, with its own sandboxes
   *  and its own money. What makes it useful is that both are recorded the same
   *  way, so the comparison afterwards is arithmetic — cost, duration, checks
   *  met, decision breakdowns — rather than an impression. */
  replay: publicProcedure
    .input(z.object({ nodeId: z.string(), mandateId: z.string().nullable().default(null) }))
    .mutation(({ input, ctx }) => {
      const original = getNode(ctx.db, input.nodeId);
      if (!original) throw new Error(`Node ${input.nodeId} not found`);
      const mandate = input.mandateId ? getMandate(ctx.db, input.mandateId) : undefined;
      if (input.mandateId && !mandate) throw new Error(`Mandate ${input.mandateId} not found`);

      const contract = mandate
        ? { ...original.contract, authority: mandate.authority, constraints: mandate.constraints }
        : original.contract;
      const id = randomUUID();
      const now = new Date().toISOString();
      insertNode(ctx.db, {
        id, parentId: null, goal: original.goal, contract,
        state: 'CREATED', repoPath: original.repoPath ?? null,
        mandateId: mandate?.id ?? null, replayOf: original.id, snapshot: null,
        createdAt: now, updatedAt: now,
      });
      insertCommitment(ctx.db, {
        id: randomUUID(), owner: id, goal: original.goal,
        definition_of_done: contract.definition_of_done,
        status: 'pending', created_at: now, dependencies: [], evidence: [], risks: [],
      }, now);
      insertDodItems(ctx.db, id, contract.definition_of_done, now, () => randomUUID());
      ctx.startNode(ctx.db, id, original.goal);
      return { id };
    }),

  /** The two runs side by side. Every field is a number or a count, because the
   *  point of a fork is to answer "was the cheaper mandate good enough" without
   *  anyone having to form an impression. */
  compare: publicProcedure
    .input(z.object({ aId: z.string(), bId: z.string() }))
    .query(({ input, ctx }) => {
      const side = (id: string) => {
        const node = getNode(ctx.db, id);
        if (!node) throw new Error(`Node ${id} not found`);
        const subtree = subtreeNodeIds(ctx.db, id);
        const items = subtree.flatMap((childId) => listDodForNode(ctx.db, childId));
        const costUsd = getCostForNodes(ctx.db, subtree);
        return {
          node,
          mandate: node.mandateId ? getMandate(ctx.db, node.mandateId) ?? null : null,
          agents: subtree.length,
          costUsd,
          budgetUsd: node.contract.authority.budget_usd,
          durationMs: Math.max(0, Date.parse(node.updatedAt) - Date.parse(node.createdAt)),
          dod: dodProgress(items),
          artifacts: subtree.flatMap((childId) => listArtifactsForNode(ctx.db, childId)).length,
          decisions: subtree.flatMap((childId) => listDecisionsForNode(ctx.db, childId)),
        };
      };
      return { a: side(input.aId), b: side(input.bId) };
    }),

  /** Starts an INTERRUPTED node again from where the daemon stopped. Spending
   *  money is a person's call, which is the whole reason this is a button
   *  rather than something a daemon boot does on its own. */
  resume: publicProcedure
    .input(z.object({ nodeId: z.string() }))
    .mutation(({ input, ctx }) => {
      resumeNode(ctx.db, input.nodeId);
      return { ok: true as const };
    }),

  /** Marks one definition-of-done item against the evidence that closed it. A
   *  person's judgement is recorded as a person's judgement — the note is kept,
   *  so a green check can always be traced to why someone made it green. */
  setDod: publicProcedure
    .input(z.object({
      id: z.string(),
      state: z.enum(['met', 'unmet', 'unverified']),
      artifactId: z.string().nullable().default(null),
      note: z.string().nullable().default(null),
    }))
    .mutation(({ input, ctx }) => {
      setDodState(ctx.db, input.id, input.state, { artifactId: input.artifactId, note: input.note }, new Date().toISOString());
      return { ok: true as const };
    }),

  /** Stops a whole task at once — every agent under it, however deep.
   *
   *  Stopping an organization one agent at a time does not work: cancelling a
   *  child makes its parent re-plan and dispatch a replacement faster than
   *  anyone can click. */
  cancelCase: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const root = getNode(ctx.db, input.id);
      if (!root) throw new Error(`Case ${input.id} not found`);
      return cancelSubtree(ctx.db, input.id);
    }),

  resolveApproval: publicProcedure
    .input(z.object({ approvalId: z.string(), decision: z.enum(['approved', 'rejected']) }))
    .mutation(({ input, ctx }) => {
      // The approval record knows its nodeId — look it up rather than requiring
      // the caller to pass both, since `org approve <id>` only has the id.
      const approval = getApproval(ctx.db, input.approvalId);
      if (!approval) throw new Error(`Approval ${input.approvalId} not found`);
      if (approval.status !== 'pending') {
        throw new Error(`Approval ${input.approvalId} was already ${approval.status}`);
      }
      // Notify first, resolve second. The actor registry is in-process, so a daemon
      // restart since the escalation leaves no actor to send to — burning the
      // approval row before finding that out would strand the node in
      // WAIT_APPROVAL with no second chance to approve it.
      // Rehydration puts a node parked here back on daemon boot, so this is now
      // the genuinely broken case rather than the routine one: no snapshot to
      // restore from, or a machine that changed shape under it.
      if (!getNodeActor(approval.nodeId)) {
        throw new Error(`Node ${approval.nodeId} could not be restored, so this approval can no longer be acted on. Start the task again.`);
      }
      sendToNode(approval.nodeId, { type: input.decision === 'approved' ? 'APPROVED' : 'REJECTED' });
      resolveApproval(ctx.db, input.approvalId, input.decision, new Date().toISOString());
      return { ok: true as const };
    }),

  /** The work model: what is ready, what is blocked and on what, and how much
   *  finished work was reused rather than repeated. Derived from the nodes and
   *  events that already exist — there is no second store to disagree with. */
  executionGraph: publicProcedure.query(({ ctx }) => {
    const graph = executionGraph(ctx.db);
    return {
      summary: graphSummary(graph),
      ready: readyNodes(graph).map((node) => ({ id: node.id, goal: node.goal })),
      blocked: blockedNodes(graph).map(({ node, reason }) => ({ id: node.id, goal: node.goal, reason })),
      nodes: graph.map((node) => ({
        id: node.id, parentId: node.parentId, goal: node.goal,
        state: node.state, machineState: node.machineState, reused: node.reused,
      })),
    };
  }),
});
