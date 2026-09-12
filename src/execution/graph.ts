/** The work model, as a query over what the runtime already records.
 *
 *  Deliberately not a second store. Nodes are rows, their transitions are
 *  events, and both are already append-only and replayable — a parallel
 *  execution graph with its own state would be a second source of truth that
 *  can disagree with the first, which is the worst possible outcome for
 *  something whose job is knowing what is running.
 *
 *  What this adds is the vocabulary the plan asks for and the three questions
 *  a scheduler actually needs: what is ready, what is blocked, and what has
 *  already been done that this could reuse.
 */
import type { Db } from '../db/client.js';
import { listNodes } from '../db/queries/nodes.js';
import { listEventsForNode } from '../db/queries/events.js';

/** The plan's node states. `reused` is the one the machine has no equivalent
 *  for, because it is not a lifecycle state at all — it is how a node reached
 *  `completed`, and losing that distinction would make a cache hit
 *  indistinguishable from work. */
export type ExecutionNodeState =
  | 'pending' | 'ready' | 'running' | 'completed'
  | 'reused' | 'blocked' | 'failed' | 'cancelled';

/** Machine state to execution state. A state this does not know is `pending`
 *  rather than a throw: a state added to the machine later must not take the
 *  scheduler down with it. */
const STATE_MAP: Record<string, ExecutionNodeState> = {
  CREATED: 'pending',
  ORIENT: 'ready',
  PLAN: 'ready',
  INTELLIGENCE_GATE: 'ready',
  EXECUTION_DECISION: 'ready',
  SELF_EXECUTE: 'running',
  DELEGATE: 'running',
  VERIFY: 'running',
  ESCALATE: 'blocked',
  WAIT_APPROVAL: 'blocked',
  COMPLETE: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export interface ExecutionNode {
  id: string;
  parentId: string | null;
  goal: string;
  state: ExecutionNodeState;
  /** The machine state it was derived from, so a reader can get back to the
   *  underlying truth. */
  machineState: string;
  dependencies: string[];
  requiredContextRevision?: string;
  costBudgetUsd: number;
  maxTurns?: number;
  /** True when this node's result came from reuse rather than from work. */
  reused: boolean;
}

const TERMINAL: ExecutionNodeState[] = ['completed', 'reused', 'failed', 'cancelled'];

export function isTerminal(state: ExecutionNodeState): boolean {
  return TERMINAL.includes(state);
}

/** Whether a node's result was served from the cache rather than produced.
 *
 *  Read from the event log rather than stored on the node: it is a fact about
 *  how the run went, and the event log is where facts about how the run went
 *  live. */
function wasReused(db: Db, nodeId: string): boolean {
  try {
    return listEventsForNode(db, nodeId).some((event) =>
      event.type === 'step.progress'
      && /reusing that answer|already answered against this commit/i.test(
        String((event.payload as { message?: unknown } | null)?.message ?? '')));
  } catch {
    return false;
  }
}

export function executionGraph(db: Db): ExecutionNode[] {
  const rows = listNodes(db);
  const childrenOf = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    childrenOf.set(row.parentId, [...(childrenOf.get(row.parentId) ?? []), row.id]);
  }

  return rows.map((row) => {
    const base = STATE_MAP[row.state] ?? 'pending';
    const reused = base === 'completed' && wasReused(db, row.id);
    return {
      id: row.id,
      parentId: row.parentId,
      goal: row.goal,
      state: reused ? 'reused' : base,
      machineState: row.state,
      // A parent depends on its children: it cannot finish until they have.
      dependencies: childrenOf.get(row.id) ?? [],
      costBudgetUsd: row.contract.authority.budget_usd,
      reused,
    };
  });
}

/** Nodes that could run now: not terminal, not already running, and with every
 *  dependency settled. */
export function readyNodes(graph: ExecutionNode[]): ExecutionNode[] {
  const byId = new Map(graph.map((node) => [node.id, node]));
  return graph.filter((node) => {
    if (isTerminal(node.state) || node.state === 'running' || node.state === 'blocked') return false;
    return node.dependencies.every((id) => {
      const dependency = byId.get(id);
      return dependency === undefined || isTerminal(dependency.state);
    });
  });
}

/** Nodes waiting on something: a human, or an unfinished dependency. The two
 *  are reported together because from a scheduler's point of view they are the
 *  same fact — this cannot proceed — and separated by `reason` because from an
 *  operator's point of view they could not be more different. */
export function blockedNodes(graph: ExecutionNode[]): { node: ExecutionNode; reason: string }[] {
  const byId = new Map(graph.map((node) => [node.id, node]));
  const blocked: { node: ExecutionNode; reason: string }[] = [];

  for (const node of graph) {
    if (isTerminal(node.state)) continue;
    if (node.state === 'blocked') {
      blocked.push({ node, reason: 'waiting on a person' });
      continue;
    }
    const unfinished = node.dependencies
      .map((id) => byId.get(id))
      .filter((dependency) => dependency !== undefined && !isTerminal(dependency.state));
    if (unfinished.length > 0) {
      blocked.push({ node, reason: `waiting on ${unfinished.length} unfinished agent${unfinished.length === 1 ? '' : 's'}` });
    }
  }
  return blocked;
}

/** Completed nodes whose goal matches, newest first — what a node about to run
 *  could reuse instead.
 *
 *  Candidates only. Whether reuse is *valid* is a dependency question answered
 *  by `context/dependencies.ts`; this just says what there is to consider. */
export function reuseCandidates(graph: ExecutionNode[], goal: string): ExecutionNode[] {
  const wanted = goal.trim().toLowerCase();
  return graph.filter((node) =>
    (node.state === 'completed' || node.state === 'reused')
    && node.goal.trim().toLowerCase() === wanted);
}

/** Counts by state. What a status line reads. */
export function graphSummary(graph: ExecutionNode[]): Record<ExecutionNodeState, number> {
  const summary = {
    pending: 0, ready: 0, running: 0, completed: 0,
    reused: 0, blocked: 0, failed: 0, cancelled: 0,
  };
  for (const node of graph) summary[node.state]++;
  return summary;
}
