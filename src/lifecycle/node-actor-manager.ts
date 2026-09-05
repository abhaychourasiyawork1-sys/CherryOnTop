import { randomUUID } from 'node:crypto';
import { createActor, fromPromise, waitFor, type Actor } from 'xstate';
import { nodeMachine, type NodeMachineEvent } from './node-machine.js';
import type { Db } from '../db/client.js';
import { updateNodeState, getNode, insertNode } from '../db/queries/nodes.js';
import { appendEvent } from '../db/queries/events.js';
import { executeStep } from '../execution/execute-step.js';
import { claudeCodeAdapter } from '../adapters/claude-code.js';
import { assessUncertainty } from '../intelligence/coordinator.js';
import { decideExecution } from '../engines/decide-execution.js';
import { insertDecision } from '../db/queries/decisions.js';
import type { NodeMachineContext } from './node-machine.js';
import { delegateToChild, type DelegateChildDeps } from './delegate-child.js';
import { insertCommitment } from '../db/queries/commitments.js';
import { effectiveAuthority } from '../engines/authority.js';
import { CHILD_BUDGET_USD } from '../engines/decide-execution.js';
import { deleteNodeNetworkPolicy } from '../k8s/cleanup.js';

// ponytail: in-process actor registry, lost on daemon restart. Rehydrate from the
// event log if nodes need to survive a restart.
const actors = new Map<string, Actor<typeof nodeMachine>>();

const NAMESPACE = process.env.ORG_K8S_NAMESPACE ?? 'org-exec';

function realDelegateDeps(db: Db): DelegateChildDeps {
  return {
    createChildNode: (parentId, goal, budgetUsd) => {
      const parent = getNode(db, parentId);
      if (!parent) throw new Error(`Parent node ${parentId} not found`);
      const id = randomUUID();
      const now = new Date().toISOString();
      const parentAuthority = parent.contract.authority;
      // There is no separate platform-policy concept in the codebase yet (doc §8
      // describes one, nothing implements it), so the parent's own authority
      // stands in as the platform maximum.
      // Delegation depth is bounded by max_child_count: each generation spends
      // one, and a child with none left cannot spawn. Without this a goal that
      // reads as high-complexity delegates to a child with the same goal, which
      // delegates again, forever.
      const remainingChildren = Math.max(parentAuthority.max_child_count - 1, 0);
      const childAuthority = effectiveAuthority(parentAuthority, parentAuthority, {
        ...parentAuthority,
        budget_usd: budgetUsd,
        max_child_count: remainingChildren,
        spawn_children: remainingChildren > 0,
      });
      insertNode(db, {
        id, parentId, goal,
        contract: { ...parent.contract, goal, authority: childAuthority },
        state: 'CREATED', createdAt: now, updatedAt: now,
      });
      return id;
    },
    recordCommitment: (childId, goal) => {
      const now = new Date().toISOString();
      insertCommitment(db, {
        id: randomUUID(), owner: childId, goal, definition_of_done: [goal],
        status: 'pending', created_at: now,
        dependencies: [], evidence: [], risks: [],
      }, now);
    },
    startChild: (childId, goal) => startNodeActor(db, childId, goal),
    waitForChild: (childId) => waitForNodeCompletion(childId),
  };
}

function productionMachine(db: Db, nodeId: string) {
  return nodeMachine.provide({
    actors: {
      assessUncertainty: fromPromise(async ({ input }: { input: { goal: string } }) => assessUncertainty(input)),
      decideExecution: fromPromise(async ({ input }: { input: { goal: string; complexity: NodeMachineContext['complexity'] } }) => {
        const node = getNode(db, nodeId);
        if (!node) throw new Error(`Node ${nodeId} not found when deciding execution`);
        const result = decideExecution({
          goal: input.goal,
          authority: node.contract.authority,
          complexity: input.complexity ?? 'low',
        });
        insertDecision(db, {
          id: randomUUID(), nodeId, type: 'execution_decision',
          outcome: result.outcome, breakdown: result.breakdown,
          createdAt: new Date().toISOString(),
        });
        return result;
      }),
      delegateToChild: fromPromise(async ({ input }: { input: { nodeId: string; goal: string } }) =>
        delegateToChild({ parentId: nodeId, goal: input.goal, childBudgetUsd: CHILD_BUDGET_USD }, realDelegateDeps(db)),
      ),
      executeStep: fromPromise(async ({ input }) => {
        const result = await executeStep({
          nodeId,
          goal: input.goal,
          namespace: NAMESPACE,
          worktreePath: process.env.ORG_WORKTREE_PATH ?? `/tmp/org-worktrees/${nodeId}`,
          // ponytail: no credentials plumbed yet — the Secret is created empty until
          // the credential-broker task lands.
          credentials: {},
          adapter: claudeCodeAdapter,
        });
        // The runner's structured output is the point of the whole dispatch; drop it
        // into the node's event log so `org tree` can show what actually happened.
        const now = new Date().toISOString();
        for (const event of result.events) {
          appendEvent(db, { nodeId, type: `exec.${event.type}`, payload: event.payload, createdAt: now });
        }
        return result;
      }),
    },
  });
}

export function startNodeActor(db: Db, nodeId: string, goal: string): void {
  const actor = createActor(productionMachine(db, nodeId), { input: { nodeId, goal } });
  actor.subscribe((snapshot) => {
    const now = new Date().toISOString();
    updateNodeState(db, nodeId, String(snapshot.value), now);
    appendEvent(db, { nodeId, type: 'state.transition', payload: { state: snapshot.value }, createdAt: now });

    // G3 fix: the per-node egress policy outlives the node otherwise. A done
    // actor is one that reached a final state (COMPLETE/FAILED), which it never
    // leaves, so it is a safe point to release cluster-side resources.
    if (snapshot.status === 'done') {
      deleteNodeNetworkPolicy(nodeId, NAMESPACE).catch((err) => {
        console.error(`Failed to clean up NetworkPolicy for node ${nodeId}:`, err);
      });
    }
  });
  actor.start();
  actors.set(nodeId, actor);
  actor.send({ type: 'START' });
}

export function getNodeActor(nodeId: string): Actor<typeof nodeMachine> | undefined {
  return actors.get(nodeId);
}

export function sendToNode(nodeId: string, event: NodeMachineEvent): void {
  const actor = actors.get(nodeId);
  if (!actor) throw new Error(`No active actor for node ${nodeId}`);
  actor.send(event);
}

export async function waitForNodeCompletion(nodeId: string, timeoutMs = 300_000): Promise<{ succeeded: boolean }> {
  const actor = actors.get(nodeId);
  if (!actor) throw new Error(`No active actor for node ${nodeId}`);
  const snapshot = await waitFor(actor, (s) => s.status === 'done', { timeout: timeoutMs });
  // COMPLETE is the only terminal state that means the goal was met — FAILED and
  // ESCALATE are both terminal too, and neither is a success.
  return { succeeded: snapshot.value === 'COMPLETE' };
}
