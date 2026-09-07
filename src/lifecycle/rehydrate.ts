import type { Db } from '../db/client.js';
import { listNodes, updateNodeState, getNode } from '../db/queries/nodes.js';
import { appendEvent } from '../db/queries/events.js';
import { restoreNodeActor, resumesFreely, getNodeActor } from './node-actor-manager.js';
import { strandOrphanedNodes, type StrandDeps } from './orphans.js';
import { deleteNodeJobs } from '../k8s/cleanup.js';

const TERMINAL = new Set(['COMPLETE', 'FAILED', 'CANCELLED']);

/** A node whose actor stopped mid-work and can be started again from where it
 *  was. Not a failure: nothing went wrong with the work, the process holding it
 *  went away. Kept out of TERMINAL so it is never mistaken for a finished run,
 *  and out of the running states so it is never shown as busy. */
export const INTERRUPTED = 'INTERRUPTED';

export interface RecoverySummary {
  /** Put back and running again, at no cost — they were waiting on something,
   *  not doing something. */
  resumed: string[];
  /** Recoverable, but resuming spends money, so it waits for a person. */
  interrupted: string[];
  /** Ran before snapshots existed, or the snapshot is unusable. Closed out. */
  stranded: string[];
}

export interface RecoverDeps extends StrandDeps {
  releaseJobs: (nodeId: string, namespace: string) => void;
}

const NAMESPACE = process.env.ORG_K8S_NAMESPACE ?? 'org-exec';

const defaultDeps: RecoverDeps = {
  releaseClusterResources: () => {},
  releaseJobs: (nodeId, namespace) => {
    // Fire and forget: this runs before the server listens, and an unreachable
    // cluster must not stop the daemon from starting.
    deleteNodeJobs(nodeId, namespace).catch((err) => {
      console.error(`Could not delete Jobs for interrupted node ${nodeId}:`, err);
    });
  },
};

/**
 * Puts the organization back after a daemon restart.
 *
 * The rule is about who pays. A node parked on a human decision resumes for
 * free and must resume — losing someone's pending approval to a process restart
 * is the worst thing this system could do, because the approval is the whole
 * product. A node mid-execution can only continue by dispatching a fresh
 * sandbox, and spending money is a decision a person makes, so it is parked as
 * INTERRUPTED with its snapshot intact and offered a Resume.
 */
export function recoverNodes(
  db: Db,
  now = new Date().toISOString(),
  deps: Partial<RecoverDeps> = {},
): RecoverySummary {
  const d = { ...defaultDeps, ...deps };
  const summary: RecoverySummary = { resumed: [], interrupted: [], stranded: [] };

  for (const node of listNodes(db)) {
    if (TERMINAL.has(node.state) || node.state === INTERRUPTED) continue;
    if (node.snapshot === null || node.snapshot === undefined) continue; // strand sweep below

    if (resumesFreely(node.state)) {
      try {
        restoreNodeActor(db, node.id, node.goal, node.snapshot);
        summary.resumed.push(node.id);
        continue;
      } catch (err) {
        // A snapshot the current machine cannot load (the machine changed shape
        // between releases) is not recoverable. Fall through to INTERRUPTED
        // rather than crashing the daemon on boot.
        console.error(`Could not restore node ${node.id}:`, err);
      }
    }

    updateNodeState(db, node.id, INTERRUPTED, now);
    const payload = {
      message: 'The daemon stopped while this was working. Its work so far is kept — resume it to carry on from here.',
      resumable: true,
    };
    appendEvent(db, { nodeId: node.id, type: 'node.interrupted', payload, createdAt: now });
    appendEvent(db, { nodeId: node.id, type: 'state.transition', payload: { state: INTERRUPTED }, createdAt: now });
    // The old Job outlives the daemon that made it. Resuming dispatches a new
    // one, so the old one is only ever a pod nothing will read.
    d.releaseJobs(node.id, NAMESPACE);
    summary.interrupted.push(node.id);
  }

  // Anything left non-terminal has no snapshot to restore — it ran before
  // snapshots existed. Closing it out honestly is still better than showing it
  // as busy for ever.
  summary.stranded = strandOrphanedNodes(db, now, deps.releaseClusterResources ? d : undefined);
  return summary;
}

/** Starts an INTERRUPTED node again from where it stopped. */
export function resumeNode(db: Db, nodeId: string): void {
  const node = getNode(db, nodeId);
  if (!node) throw new Error(`Node ${nodeId} not found`);
  if (node.state !== INTERRUPTED) {
    throw new Error(`Node ${nodeId} is ${node.state}, not interrupted — there is nothing to resume.`);
  }
  if (!node.snapshot) throw new Error(`Node ${nodeId} has no saved state to resume from.`);
  if (getNodeActor(nodeId)) return; // already running
  restoreNodeActor(db, nodeId, node.goal, node.snapshot);
}
