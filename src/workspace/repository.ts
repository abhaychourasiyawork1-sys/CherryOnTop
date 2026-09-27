import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { workspaces } from '../db/schema.js';

export interface WorkspaceRecord {
  id: string;
  name: string;
  description: string;
  settings: Record<string, unknown>;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: string;
  updatedAt: string;
}

export function createWorkspace(
  db: Db,
  input: { id: string; name: string; description?: string; settings?: Record<string, unknown>; now: string },
): WorkspaceRecord {
  const record: WorkspaceRecord = {
    id: input.id,
    name: input.name,
    description: input.description ?? '',
    settings: input.settings ?? {},
    status: 'ACTIVE',
    createdAt: input.now,
    updatedAt: input.now,
  };
  db.insert(workspaces).values(record).run();
  return record;
}

export function getWorkspace(db: Db, id: string): WorkspaceRecord | undefined {
  return db.select().from(workspaces).where(eq(workspaces.id, id)).get() as WorkspaceRecord | undefined;
}

export function listWorkspaces(db: Db): WorkspaceRecord[] {
  return db.select().from(workspaces).orderBy(desc(workspaces.updatedAt)).all() as WorkspaceRecord[];
}

export function archiveWorkspace(db: Db, id: string, updatedAt: string): void {
  db.update(workspaces).set({ status: 'ARCHIVED', updatedAt }).where(eq(workspaces.id, id)).run();
}
