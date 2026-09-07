import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import { listNodes, updateNodeState } from '../db/queries/nodes.js';
import { appendEvent } from '../db/queries/events.js';
import { listCommitmentsForNode, updateCommitmentStatus } from '../db/queries/commitments.js';
import { getPendingApproval, resolveApproval } from '../db/queries/approvals.js';
import { deleteNodeJobs, deleteNodeNetworkPolicy } from '../k8s/cleanup.js';

// INTERRUPTED is deliberately not terminal — it is a node waiting to be resumed
// — but it is also not stranded, so the sweep must leave it alone.
const TERMINAL = new Set(['COMPLETE', 'FAILED', 'CANCELLED', 'INTERRUPTED']);

/** Node actors live in the daemon's memory, so a restart leaves every run that
 *  was in flight with no actor to drive it. Those nodes used to sit in
 *  `DELEGATE` or `SELF_EXECUTE` for ever — shown as busy, waited on by parents,
 *  and offered by `org approve` — with nothing about to happen.
 *
 *  Rehydration (rehydrate.ts) handles everything with a saved snapshot. This is
 *  the remainder: nodes that ran before snapshots existed, and so have no state
 *  to restore. Saying plainly that they stopped is the only honest option left.
 *  Returns the ids it closed. */
export interface StrandDeps {
  /** Cluster teardown, injectable so the sweep is testable without a cluster. */
  releaseClusterResources: (nodeId: string, namespace: string) => void;
}

const NAMESPACE = process.env.ORG_K8S_NAMESPACE ?? 'org-exec';

const defaultDeps: StrandDeps = {
  releaseClusterResources: (nodeId, namespace) => {
    // Fire and forget: the sweep runs before the server listens, and a cluster
    // that is unreachable must not stop the daemon from starting.
    deleteNodeJobs(nodeId, namespace).catch((err) => {
      console.error(`Could not delete Jobs for stranded node ${nodeId}:`, err);
    });
    deleteNodeNetworkPolicy(nodeId, namespace).catch((err) => {
      console.error(`Could not delete NetworkPolicy for stranded node ${nodeId}:`, err);
    });
  },
};

export function strandOrphanedNodes(
  db: Db,
  now = new Date().toISOString(),
  deps: StrandDeps = defaultDeps,
): string[] {
  // A node with a saved snapshot belongs to rehydrate.ts — it was either put
  // back and is running again, or parked as INTERRUPTED for a person to resume.
  // Stranding it here would undo that, and in the WAIT_APPROVAL case would
  // cancel the very approval the restore existed to preserve.
  const stranded = listNodes(db).filter(
    (node) => !TERMINAL.has(node.state) && node.snapshot === null,
  );

  for (const node of stranded) {
    updateNodeState(db, node.id, 'FAILED', now);

    const payload = {
      succeeded: false,
      message: 'The daemon restarted while this was running, so it stopped where it was. Start the task again to pick it up.',
    };
    appendEvent(db, { nodeId: node.id, type: 'step.outcome', payload, createdAt: now });
    appendEvent(db, { nodeId: node.id, type: 'state.transition', payload: { state: 'FAILED' }, createdAt: now });

    for (const commitment of listCommitmentsForNode(db, node.id)) {
      updateCommitmentStatus(db, commitment.id, 'failed', now);
    }

    // An approval on a node that can no longer be resumed is a dead end: the
    // inbox would offer it, and approving it would fail with "no active actor".
    const pending = getPendingApproval(db, node.id);
    if (pending) resolveApproval(db, pending.id, 'cancelled', now);

    // The node's Job outlives the daemon that created it. Left alone it sits in
    // the cluster for ever — one was found stuck in ContainerCreating for 41
    // minutes — holding a pod nothing will ever read.
    deps.releaseClusterResources(node.id, NAMESPACE);
  }

  // Nothing is published on the event bus: this runs before anything can be
  // subscribed, and the rows are what a client reads on connect.
  return stranded.map((node) => node.id);
}
