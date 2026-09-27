import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { projects } from '../db/schema.js';

export interface ProjectRecord {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  settings: Record<string, unknown>;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: string;
  updatedAt: string;
}

export function createProject(
  db: Db,
  input: { id: string; workspaceId: string; name: string; description?: string; settings?: Record<string, unknown>; now: string },
): ProjectRecord {
  const record: ProjectRecord = {
    id: input.id,
    workspaceId: input.workspaceId,
    name: input.name,
    description: input.description ?? '',
    settings: input.settings ?? {},
    status: 'ACTIVE',
    createdAt: input.now,
    updatedAt: input.now,
  };
  db.insert(projects).values(record).run();
  return record;
}

export function getProject(db: Db, id: string): ProjectRecord | undefined {
  return db.select().from(projects).where(eq(projects.id, id)).get() as ProjectRecord | undefined;
}

export function listProjects(db: Db, workspaceId: string): ProjectRecord[] {
  return db.select().from(projects).where(eq(projects.workspaceId, workspaceId))
    .orderBy(desc(projects.updatedAt)).all() as ProjectRecord[];
}
