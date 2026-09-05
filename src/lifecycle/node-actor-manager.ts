import { randomUUID } from 'node:crypto';
import { createActor, fromPromise, waitFor, type Actor } from 'xstate';
import { nodeMachine, type NodeMachineEvent } from './node-machine.js';
import type { Db } from '../db/client.js';
import { updateNodeState, getNode, insertNode } from '../db/queries/nodes.js';
import { appendEvent } from '../db/queries/events.js';
import { publish } from '../events/bus.js';
import { executeStep } from '../execution/execute-step.js';
import { claudeCodeAdapter } from '../adapters/claude-code.js';
import { stopgapAdapter } from '../adapters/stopgap.js';
import { assessUncertainty } from '../intelligence/coordinator.js';
import { decideExecution } from '../engines/decide-execution.js';
import { insertDecision } from '../db/queries/decisions.js';
import { escalate } from '../approvals/escalation.js';
import { insertApproval } from '../db/queries/approvals.js';
import type { NodeMachineContext } from './node-machine.js';
import { delegateToChild, childAuthority, type DelegateChildDeps } from './delegate-child.js';
import { insertCommitment, updateCommitmentStatus, listCommitmentsForNode } from '../db/queries/commitments.js';
import { resolveCredentials } from '../execution/credentials.js';
import os from 'node:os';
import { CHILD_BUDGET_USD } from '../engines/decide-execution.js';
import { deleteNodeNetworkPolicy } from '../k8s/cleanup.js';

// ponytail: in-process actor registry, lost on daemon restart. Rehydrate from the
// event log if nodes need to survive a restart.
const actors = new Map<string, Actor<typeof nodeMachine>>();

const NAMESPACE = process.env.ORG_K8S_NAMESPACE ?? 'org-exec';

// ponytail: the default runner image (execute-step.ts) is not published yet, so
// there is no image a real dispatch can actually pull. Setting ORG_RUNNER_IMAGE
// swaps in a stand-in image and the matching stopgap adapter — the escape hatch
// integration tests use, and the one to delete once Phase 5 ships the image.
// Read per dispatch, not at import: tests set it after this module is loaded.
function runnerImageOverride(): string | undefined {
  return process.env.ORG_RUNNER_IMAGE;
}

function realDelegateDeps(db: Db): DelegateChildDeps {
  return {
    createChildNode: (parentId, goal, budgetUsd, approvedBudgetUsd) => {
      const parent = getNode(db, parentId);
      if (!parent) throw new Error(`Parent node ${parentId} not found`);
      const id = randomUUID();
      const now = new Date().toISOString();
      insertNode(db, {
        id, parentId, goal,
        contract: {
          ...parent.contract, goal,
          authority: childAuthority(parent.contract.authority, budgetUsd, approvedBudgetUsd),
        },
        state: 'CREATED', repoPath: parent.repoPath, createdAt: now, updatedAt: now,
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
      escalate: fromPromise(async ({ input }: { input: { nodeId: string; reason: string } }) =>
        escalate(input.nodeId, input.reason, { insertApproval: (record) => insertApproval(db, record) }),
      ),
      delegateToChild: fromPromise(async ({ input }: { input: { nodeId: string; goal: string; approvedBudgetUsd?: number } }) =>
        delegateToChild({
          parentId: nodeId, goal: input.goal,
          childBudgetUsd: CHILD_BUDGET_USD, approvedBudgetUsd: input.approvedBudgetUsd,
        }, realDelegateDeps(db)),
      ),
      executeStep: fromPromise(async ({ input }) => {
        const node = getNode(db, nodeId);
        const result = await executeStep({
          nodeId,
          goal: input.goal,
          namespace: NAMESPACE,
          // Falls back to the old /tmp path only when no --repo was given.
          worktreePath: node?.repoPath ?? process.env.ORG_WORKTREE_PATH ?? `/tmp/org-worktrees/${nodeId}`,
          // Subscription (via `claude login`) is preferred over an API key —
          // see credentials.ts. Read fresh on every dispatch, so unlike the
          // ANTHROPIC_API_KEY env var this path has no daemon-restart staleness.
          credentials: resolveCredentials(os.homedir(), process.env.ANTHROPIC_API_KEY),
          adapter: runnerImageOverride() ? stopgapAdapter : claudeCodeAdapter,
          image: runnerImageOverride(),
          // The runner's structured output is the point of the whole dispatch.
          // Was: a loop over result.events run once, after the whole Job
          // finished. Now: called per-event, live, as executeStep's follow-mode
          // stream delivers them — this is what makes the TUI's live output real.
          onEvent: (event) => {
            const now = new Date().toISOString();
            const type = `exec.${event.type}`;
            const id = appendEvent(db, { nodeId, type, payload: event.payload, createdAt: now });
            publish({ id, nodeId, type, payload: event.payload, createdAt: now });
          },
        });
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
    const transitionId = appendEvent(db, { nodeId, type: 'state.transition', payload: { state: snapshot.value }, createdAt: now });
    publish({ id: transitionId, nodeId, type: 'state.transition', payload: { state: snapshot.value }, createdAt: now });

    // G3 fix: the per-node egress policy outlives the node otherwise. A done
    // actor is one that reached a final state (COMPLETE/FAILED), which it never
    // leaves, so it is a safe point to release cluster-side resources.
    if (snapshot.status === 'done') {
      // A node's commitment is only accountable if it is closed out; the
      // terminal transition is the one place that knows the verdict.
      const outcome = snapshot.value === 'COMPLETE' ? 'completed' : 'failed';
      for (const commitment of listCommitmentsForNode(db, nodeId)) {
        updateCommitmentStatus(db, commitment.id, outcome, now);
      }
      deleteNodeNetworkPolicy(nodeId, NAMESPACE).catch((err) => {
        console.error(`Failed to clean up NetworkPolicy for node ${nodeId}:`, err);
      });
      // Drop the actor: otherwise every node ever run stays resident in a
      // long-lived daemon. Deferred a tick so anything awaiting this same
      // transition (waitForNodeCompletion, a delegating parent) still resolves.
      setTimeout(() => actors.delete(nodeId), 0);
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
