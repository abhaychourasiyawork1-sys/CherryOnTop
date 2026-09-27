import { createContext, useContext } from 'react';
import type { Org, OrgNode } from '../lib/useOrg.js';
import type { Workspace } from '../lib/workspaces.js';
import type { LayoutApi } from '../lib/useLayout.js';
import type { Section } from '../lib/view.js';
import type { Mandate } from '../lib/mandates.js';
import type { ContextRef } from '../composer/ContextResolver.js';

/** Everything a surface inside a Workspace needs, without threading a dozen
 *  props through every layer. The backend-backed parts (`org`) are the live
 *  projection; the rest is UI state and the actions a surface may request. */
export interface WorkspaceApi {
  org: Org;
  workspace: Workspace;
  /** The run the Workspace is focused on: what Plan, Decisions, Evidence and
   *  Agents describe. */
  activeCase: OrgNode | null;
  activeSubtree: OrgNode[];
  activeStamp: string;
  focusCase: (caseId: string) => void;
  openSection: (section: Section, nodeId?: string | null) => void;
  surfaces: LayoutApi;
  /** Why work cannot be started in this Workspace from this window, if so. */
  blockedReason: string | null;
  mandates: Mandate[];
  mandateId: string | null;
  setMandateId: (id: string | null) => void;
  /** Starts a run in this Workspace and returns its id. */
  startWork: (goal: string) => Promise<string>;
  resolveApproval: (approvalId: string, decision: 'approved' | 'rejected') => Promise<void>;
  resume: (nodeId: string) => Promise<void>;
  /** Detaches a Deep Dive into its own window, when running in Electron. */
  detach?: (target: string) => void;
  /** Starts a focused conversation seeded with this run. */
  branchFrom?: (caseId: string) => void;
  /** Context the composer should offer, from what is open. */
  contextRefs: ContextRef[];
}

export const WorkspaceContext = createContext<WorkspaceApi | null>(null);

export function useWorkspace(): WorkspaceApi {
  const api = useContext(WorkspaceContext);
  if (!api) throw new Error('useWorkspace outside a Workspace');
  return api;
}
