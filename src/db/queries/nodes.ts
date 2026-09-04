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
