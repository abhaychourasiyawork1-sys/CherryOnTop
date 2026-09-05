import { randomUUID } from 'node:crypto';
import { createActor, fromPromise, type Actor } from 'xstate';
import { nodeMachine, type NodeMachineEvent } from './node-machine.js';
import type { Db } from '../db/client.js';
import { updateNodeState, getNode } from '../db/queries/nodes.js';
import { appendEvent } from '../db/queries/events.js';
import { executeStep } from '../execution/execute-step.js';
import { claudeCodeAdapter } from '../adapters/claude-code.js';
import { assessUncertainty } from '../intelligence/coordinator.js';
import { decideExecution } from '../engines/decide-execution.js';
import { insertDecision } from '../db/queries/decisions.js';
import type { NodeMachineContext } from './node-machine.js';
import { deleteNodeNetworkPolicy } from '../k8s/cleanup.js';

// ponytail: in-process actor registry, lost on daemon restart. Rehydrate from the
// event log if nodes need to survive a restart.
const actors = new Map<string, Actor<typeof nodeMachine>>();

const NAMESPACE = process.env.ORG_K8S_NAMESPACE ?? 'org-exec';

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
