import { isTerminal } from './state.js';
import type { Workspace } from './workspaces.js';
import type { OrgNode } from './useOrg.js';

/** Home answers "what should I continue?", not "what are the numbers?". It is a
 *  projection over Workspaces and the time the window was last looked at. */

export interface AwayEntry {
  workspaceKey: string;
  workspaceName: string;
  finished: OrgNode[];
  failed: OrgNode[];
}

export interface HomeModel {
  /** Nothing has ever been asked. Home is only an invitation. */
  empty: boolean;
  continueWith: Workspace[];
  away: AwayEntry[];
  /** Nothing is running, nothing needs anyone, nothing happened while away. */
  quiet: boolean;
}

const CONTINUE_LIMIT = 4;

/** Background work that settled after `lastSeen`, one entry per Workspace so a
 *  benchmark that finished thirty runs is one line, not thirty. A superseded
 *  failure is not news — its replacement is. */
export function whileAway(workspaces: Workspace[], lastSeen: string | null): AwayEntry[] {
  if (!lastSeen) return [];
  return workspaces
    .map((workspace) => {
      const settled = workspace.cases.filter((root) =>
        isTerminal(root.state) && root.updatedAt > lastSeen && !root.supersededBy);
      return {
        workspaceKey: workspace.key,
        workspaceName: workspace.name,
        finished: settled.filter((root) => root.state === 'COMPLETE'),
        failed: settled.filter((root) => root.state !== 'COMPLETE'),
      };
    })
    .filter((entry) => entry.finished.length + entry.failed.length > 0);
}

export function homeModel(workspaces: Workspace[], lastSeen: string | null, attention: number): HomeModel {
  const away = whileAway(workspaces, lastSeen);
  const busy = workspaces.some((workspace) => workspace.running > 0);
  return {
    empty: workspaces.length === 0,
    continueWith: workspaces.slice(0, CONTINUE_LIMIT),
    away,
    quiet: !busy && attention === 0 && away.length === 0,
  };
}
