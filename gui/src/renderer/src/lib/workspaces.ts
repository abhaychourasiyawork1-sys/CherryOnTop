import { isTerminal } from './state.js';
import { basename } from './format.js';
import type { OrgNode } from './useOrg.js';

/** A Workspace is one coherent project: the repository work was done in.
 *
 *  The runtime has no Workspace table and does not need one — every root node
 *  already records the repository it ran against, so a Workspace is a
 *  projection over roots grouped by that path. Adding a second store for it
 *  would be a second truth to reconcile, which is exactly what the Desktop must
 *  not become.
 *
 *  Benchmark and per-run worktrees (`<repo>/.bench/worktrees/<id>`) are
 *  throwaway copies of one repository, so they fold into it. A named branch
 *  worktree (`<repo>/.worktrees/<name>`) is a deliberate second line of work
 *  and stays its own Workspace. */
export const UNASSIGNED = 'unassigned';

export function workspaceKeyOf(repoPath: string | null | undefined): string {
  if (!repoPath) return UNASSIGNED;
  return repoPath.replace(/\/\.bench\/worktrees\/.*$/, '').replace(/\/+$/, '') || UNASSIGNED;
}

export function workspaceNameOf(key: string): string {
  if (key === UNASSIGNED) return 'Unfiled work';
  const branch = key.match(/\/([^/]+)\/\.worktrees\/([^/]+)$/);
  if (branch) return `${branch[1]} · ${branch[2]}`;
  return basename(key);
}

export type WorkspaceState = 'ready' | 'working' | 'waiting' | 'attention' | 'syncing' | 'offline';

export interface Workspace {
  key: string;
  name: string;
  /** Root nodes — one per thing the user asked for — newest first. */
  cases: OrgNode[];
  lastActivity: string;
  running: number;
  /** Nodes anywhere in the Workspace that are waiting on a person. */
  needsYou: number;
  /** Any case here has more than one agent, a decision on record, or refused
   *  something — i.e. there is an organization worth revealing. */
  organized: boolean;
}

/** Live states the organization is waiting in rather than working in. */
const WAITING = new Set(['INTERRUPTED', 'WAIT_APPROVAL', 'ESCALATE']);

export function toWorkspaces(nodes: OrgNode[]): Workspace[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const rootOf = (node: OrgNode): OrgNode => {
    let current = node;
    const guard = new Set<string>();
    while (current.parentId && byId.has(current.parentId) && !guard.has(current.id)) {
      guard.add(current.id);
      current = byId.get(current.parentId)!;
    }
    return current;
  };

  const groups = new Map<string, { roots: OrgNode[]; all: OrgNode[] }>();
  for (const node of nodes) {
    const root = rootOf(node);
    const key = workspaceKeyOf(root.repoPath);
    const group = groups.get(key) ?? { roots: [], all: [] };
    if (root.id === node.id) group.roots.push(node);
    group.all.push(node);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([key, group]) => {
      const cases = group.roots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const lastActivity = group.all.reduce((latest, node) => (node.updatedAt > latest ? node.updatedAt : latest), '');
      return {
        key,
        name: workspaceNameOf(key),
        cases,
        lastActivity,
        running: cases.filter((root) => !isTerminal(root.state) && root.state !== 'INTERRUPTED').length,
        needsYou: group.all.filter((node) => node.needsApproval).length,
        organized: cases.some((root) => root.childCount > 0) || group.all.length > cases.length,
      };
    })
    // Where something is happening first, then most recently touched.
    .sort((a, b) => (Number(b.running > 0 || b.needsYou > 0) - Number(a.running > 0 || a.needsYou > 0))
      || b.lastActivity.localeCompare(a.lastActivity));
}

/** The one word the Workspace header shows. It describes the *Workspace*, not
 *  whichever run happens to be selected: a Workspace with one finished run and
 *  one still going is Working. */
export function workspaceState(
  workspace: Pick<Workspace, 'running' | 'needsYou'> & { cases: Pick<OrgNode, 'state'>[] } | null,
  sync: { connected: boolean; authoritative: boolean },
): WorkspaceState {
  if (!sync.connected) return 'offline';
  if (!sync.authoritative) return 'syncing';
  if (!workspace) return 'ready';
  if (workspace.needsYou > 0) return 'attention';
  if (workspace.running > 0) return 'working';
  if (workspace.cases.some((root) => WAITING.has(root.state))) return 'waiting';
  return 'ready';
}

export const STATE_LABEL: Record<WorkspaceState, string> = {
  ready: 'Ready',
  working: 'Working',
  waiting: 'Waiting',
  attention: 'Needs you',
  syncing: 'Syncing',
  offline: 'Offline',
};
