import { createActor, type Actor } from 'xstate';
import { nodeMachine, type NodeMachineEvent } from './node-machine.js';
import type { Db } from '../db/client.js';
import { updateNodeState } from '../db/queries/nodes.js';
import { appendEvent } from '../db/queries/events.js';

// ponytail: in-process actor registry, lost on daemon restart. Rehydrate from the
// event log if nodes need to survive a restart.
const actors = new Map<string, Actor<typeof nodeMachine>>();

export function startNodeActor(db: Db, nodeId: string, goal: string): void {
  const actor = createActor(nodeMachine, { input: { nodeId, goal } });
  actor.subscribe((snapshot) => {
    const now = new Date().toISOString();
    updateNodeState(db, nodeId, String(snapshot.value), now);
    appendEvent(db, { nodeId, type: 'state.transition', payload: { state: snapshot.value }, createdAt: now });
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
