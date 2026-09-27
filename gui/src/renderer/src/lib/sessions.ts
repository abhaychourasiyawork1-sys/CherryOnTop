import { workspaceKeyOf } from './workspaces.js';
import { titleOf, phaseOf, isLive } from './run.js';
import { subtreeOf } from './tasks.js';
import type { OrgNode } from './useOrg.js';

/** A chat session as the daemon stores it (src/db/queries/sessions.ts). */
export interface Session {
  id: string;
  repoPath: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRow {
  id: string;
  title: string;
  updatedAt: string;
  live: boolean;
  runIds: string[];
}

/** Sessions grouped under the Workspace they belong to, newest first, each
 *  with its runs (oldest first — the order the conversation was had in). */
export function sessionsByWorkspace(sessions: Session[], nodes: OrgNode[]): Map<string, SessionRow[]> {
  const runs = new Map<string, OrgNode[]>();
  for (const node of nodes) {
    if (node.parentId || !node.sessionId) continue;
    runs.set(node.sessionId, [...(runs.get(node.sessionId) ?? []), node]);
  }
  const out = new Map<string, SessionRow[]>();
  const ordered = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const session of ordered) {
    const own = (runs.get(session.id) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const key = workspaceKeyOf(session.repoPath);
    const row: SessionRow = {
      id: session.id,
      title: session.title,
      updatedAt: [session.updatedAt, ...own.map((r) => r.updatedAt)].sort().at(-1)!,
      live: own.some((root) => isLive(phaseOf(root, subtreeOf(nodes, root.id)))),
      runIds: own.map((r) => r.id),
    };
    out.set(key, [...(out.get(key) ?? []), row]);
  }
  return out;
}

/** A session is named after what it was first asked, the way chat apps name
 *  a conversation after its first message. */
export function sessionTitle(goal: string): string {
  const title = titleOf(goal).replace(/[.…]+$/, '').trim();
  return title.length > 60 ? `${title.slice(0, 59).trimEnd()}…` : title || 'New session';
}
