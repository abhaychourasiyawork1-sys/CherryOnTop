import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../client.js';
import { artifacts } from '../schema.js';
import type { ArtifactKind } from '../../execution/artifacts.js';

export interface ArtifactRecord {
  id: string;
  nodeId: string;
  kind: ArtifactKind;
  path: string | null;
  summary: string;
  eventId?: number | null;
  createdAt: string;
}

export function insertArtifact(db: Db, record: ArtifactRecord): void {
  db.insert(artifacts).values(record).run();
}

export function listArtifactsForNode(db: Db, nodeId: string): ArtifactRecord[] {
  return db.select().from(artifacts).where(eq(artifacts.nodeId, nodeId)).all() as ArtifactRecord[];
}

/** Everything produced under a node, its own work included. A parent that
 *  delegated all of its work has no artifacts of its own but is still
 *  accountable for its children's. */
export function listArtifactsForNodes(db: Db, nodeIds: string[]): ArtifactRecord[] {
  if (nodeIds.length === 0) return [];
  return db.select().from(artifacts).where(inArray(artifacts.nodeId, nodeIds)).all() as ArtifactRecord[];
}
