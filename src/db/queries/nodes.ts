import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { nodes } from '../schema.js';
import type { NodeContract } from '../../schemas/node-contract.js';

export interface NodeRecord {
  id: string;
  parentId: string | null;
  goal: string;
  contract: NodeContract;
  state: string;
  /** The container-side path of the repo this node operates on (see
   *  toContainerPath). Optional: a node created before --repo, or without it,
   *  has none. */
  repoPath?: string | null;
  /** Which adapter ran it, once one has been chosen. */
  runtime?: string | null;
  /** The mandate this run was authored from, when it was started from one. */
  mandateId?: string | null;
  /** The persisted actor. See setNodeSnapshot. */
  snapshot?: unknown;
  /** The run this one was forked from, if any. */
  replayOf?: string | null;
  createdAt: string;
  updatedAt: string;
}

export function insertNode(db: Db, record: NodeRecord): void {
  db.insert(nodes).values(record).run();
}

export function updateNodeState(db: Db, id: string, state: string, updatedAt: string): void {
  db.update(nodes).set({ state, updatedAt }).where(eq(nodes.id, id)).run();
}

export function getNode(db: Db, id: string): NodeRecord | undefined {
  return db.select().from(nodes).where(eq(nodes.id, id)).get() as NodeRecord | undefined;
}

export function listNodes(db: Db): NodeRecord[] {
  return db.select().from(nodes).all() as NodeRecord[];
}

/** A node and everything delegated beneath it, ids only. Walks the in-memory
 *  parent map rather than a recursive CTE: an org is tens of nodes, and this
 *  keeps cost, artifact and evidence rollups to one table scan. */
export function subtreeNodeIds(db: Db, rootId: string): string[] {
  const all = listNodes(db);
  const childrenOf = new Map<string, string[]>();
  for (const node of all) {
    if (!node.parentId) continue;
    childrenOf.set(node.parentId, [...(childrenOf.get(node.parentId) ?? []), node.id]);
  }
  const ids: string[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    // A cycle is impossible today (a child's parent is set once, at creation),
    // but a seen-check costs nothing and is the difference between a bad row
    // and an infinite loop in the daemon.
    if (ids.includes(id)) continue;
    ids.push(id);
    stack.push(...(childrenOf.get(id) ?? []));
  }
  return ids;
}

export function setNodeRuntime(db: Db, id: string, runtime: string, updatedAt: string): void {
  db.update(nodes).set({ runtime, updatedAt }).where(eq(nodes.id, id)).run();
}

/** Persists the actor after a transition, so a daemon restart can put the node
 *  back where it was. Written on every transition rather than at checkpoints:
 *  the interesting moment to survive is always the one nobody predicted, and a
 *  row write is cheap next to a sandbox dispatch. */
export function setNodeSnapshot(db: Db, id: string, snapshot: unknown): void {
  db.update(nodes).set({ snapshot }).where(eq(nodes.id, id)).run();
}

/** A terminal node has nothing to resume, and keeping its snapshot would make
 *  the row grow for ever with a state no one can re-enter. */
export function clearNodeSnapshot(db: Db, id: string): void {
  db.update(nodes).set({ snapshot: null }).where(eq(nodes.id, id)).run();
}

export function setNodeMandate(db: Db, id: string, mandateId: string | null): void {
  db.update(nodes).set({ mandateId }).where(eq(nodes.id, id)).run();
}
