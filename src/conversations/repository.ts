import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { conversations } from '../db/schema.js';

export interface ConversationRecord {
  id: string;
  workspaceId: string;
  projectId: string | null;
  title: string;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: string;
  updatedAt: string;
}

export function createConversation(
  db: Db,
  input: { id: string; workspaceId: string; projectId?: string | null; title: string; now: string },
): ConversationRecord {
  const record: ConversationRecord = {
    id: input.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId ?? null,
    title: input.title,
    status: 'ACTIVE',
    createdAt: input.now,
    updatedAt: input.now,
  };
  db.insert(conversations).values(record).run();
  return record;
}

export function getConversation(db: Db, id: string): ConversationRecord | undefined {
  return db.select().from(conversations).where(eq(conversations.id, id)).get() as ConversationRecord | undefined;
}

export function listConversations(db: Db, projectId: string): ConversationRecord[] {
  return db.select().from(conversations).where(eq(conversations.projectId, projectId))
    .orderBy(desc(conversations.updatedAt)).all() as ConversationRecord[];
}
