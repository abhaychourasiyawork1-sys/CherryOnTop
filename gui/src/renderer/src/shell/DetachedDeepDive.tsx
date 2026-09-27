import { useMemo } from 'react';
import { useOrg } from '../lib/useOrg.js';
import { useLayout } from '../lib/useLayout.js';
import { daemon } from '../lib/client.js';
import { subtreeOf } from '../lib/tasks.js';
import { caseStamp } from '../lib/useCase.js';
import { toWorkspaces, workspaceKeyOf, workspaceState } from '../lib/workspaces.js';
import { DeepDive, parseTarget } from '../surfaces/DeepDiveSurface.js';
import { WorkspaceContext, type WorkspaceApi } from './WorkspaceContext.js';
import { WorkspaceHeader } from './WorkspaceHeader.js';
import { ErrorBoundary } from './ErrorBoundary.js';

/** A Deep Dive in its own window, opened only when asked for. It reads the
 *  same daemon as the main window — nothing is passed between windows but the
 *  target — so both stay in step with the authoritative record, and closing it
 *  stops nothing. */
export function DetachedDeepDive({ target }: { target: string }) {
  const org = useOrg();
  const parsed = parseTarget(target);
  const root = parsed ? org.nodes.find((n) => n.id === parsed.caseId) ?? null : null;
  const workspace = useMemo(
    () => (root ? toWorkspaces(org.nodes).find((ws) => ws.key === workspaceKeyOf(root.repoPath)) ?? null : null),
    [org.nodes, root],
  );
  const subtree = useMemo(() => (root ? subtreeOf(org.nodes, root.id) : []), [org.nodes, root]);
  const surfaces = useLayout(null);

  if (!parsed) return <p className="surface-empty org-empty">This window has nothing to show.</p>;
  if (!root || !workspace) {
    return <p className="surface-empty org-empty">{org.authoritative ? 'That run is not on record.' : 'Reading…'}</p>;
  }

  const api: WorkspaceApi = {
    org, workspace, session: null, activeCase: root, activeSubtree: subtree, activeStamp: caseStamp(subtree),
    focusCase: () => {}, openSection: () => {}, surfaces,
    blockedReason: 'Start work from the main window.',
    mandates: [], mandateId: null, setMandateId: () => {},
    startWork: () => Promise.reject(new Error('Start work from the main window.')),
    resolveApproval: async (approvalId, decision) => {
      await daemon().node.resolveApproval.mutate({ approvalId, decision });
      org.refresh();
    },
    resume: async (nodeId) => { await daemon().node.resume.mutate({ nodeId }); org.refresh(); },
    contextRefs: [],
    openMandates: () => {},
  };

  return (
    <WorkspaceContext.Provider value={api}>
      <div className="detached">
        <WorkspaceHeader
          backLabel={null}
          onBack={() => {}}
          title={`${workspace.name} — ${parsed.kind === 'decision' ? 'Decision' : 'Evidence'}`}
          state={workspaceState(workspace, { connected: org.connected || org.error === null, authoritative: org.authoritative })}
        />
        <div className="deep-scroll">
          <ErrorBoundary what="This view">
            <DeepDive target={surfaces.layout.deepDive?.contextId ?? target} />
          </ErrorBoundary>
        </div>
      </div>
    </WorkspaceContext.Provider>
  );
}
