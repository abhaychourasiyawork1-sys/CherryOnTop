import { useMemo, useRef, useState, useEffect } from 'react';
import { useWorkspace } from './WorkspaceContext.js';
import { DecisionSurface } from '../surfaces/DecisionSurface.js';
import { DeepDive } from '../surfaces/DeepDiveSurface.js';
import { Organization } from '../panels/Organization.js';
import { Inspector } from '../panels/Inspector.js';
import { Cases } from '../panels/Cases.js';
import { Mandates } from '../panels/Mandates.js';
import { Envelope } from '../panels/Envelope.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { daemon } from '../lib/client.js';
import { useDaemonQuery } from '../lib/useDaemonQuery.js';
import { titleOf } from '../lib/run.js';
import type { Section } from '../lib/view.js';
import type { Envelope as EnvelopeData } from '../lib/mandates.js';

/** The organization underneath a Workspace, one level deeper than the
 *  conversation. Each view is about the focused run, which a quiet picker can
 *  change without going back. */
export function OrganizationView({ section, nodeId }: { section: Section; nodeId: string | null }) {
  const ws = useWorkspace();
  const caseId = ws.activeCase?.id ?? null;

  if (section === 'runs') {
    const scope = [...new Set(ws.workspace.cases.map((root) => root.repoPath).filter((p): p is string => Boolean(p)))];
    return (
      <div className="org-view org-view-wide">
        <Cases onOpenCase={(id) => { ws.focusCase(id); ws.openSection('chat'); }} revision={ws.org.revision} scope={scope} />
      </div>
    );
  }
  if (section === 'authority') return <AuthorityView />;
  if (!caseId) return <p className="surface-empty org-empty">Nothing has run in this Workspace yet.</p>;

  return (
    <div className="org-view" data-section={section}>
      <RunPicker />
      {section === 'decisions' && <div className="org-reading"><DecisionSurface caseId={caseId} /></div>}
      {section === 'evidence' && <div className="org-reading"><DeepDive target={`evidence:${caseId}`} /></div>}
      {section === 'agents' && <Agents caseId={caseId} nodeId={nodeId} />}
    </div>
  );
}

function RunPicker() {
  const ws = useWorkspace();
  if (ws.workspace.cases.length < 2 || !ws.activeCase) return null;
  return (
    <label className="run-picker">
      <span className="sr-only">Run</span>
      <select value={ws.activeCase.id} onChange={(event) => ws.focusCase(event.target.value)}>
        {ws.workspace.cases.slice(0, 60).map((root) => (
          <option key={root.id} value={root.id}>{titleOf(root.goal)}</option>
        ))}
      </select>
    </label>
  );
}

/** Individual agents, on demand: the delegation graph with its history
 *  scrubber, and one agent's full record beside it. */
function Agents({ caseId, nodeId }: { caseId: string; nodeId: string | null }) {
  const ws = useWorkspace();
  const nodes = ws.activeSubtree;
  const selected = nodes.find((node) => node.id === nodeId) ?? null;
  const approvals = useMemo(() => {
    const ids = new Set(nodes.map((n) => n.id));
    return ws.org.approvals.filter((a) => ids.has(a.nodeId));
  }, [nodes, ws.org.approvals]);

  // One spawn animation per new agent, as before.
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    const ids = new Set(nodes.map((n) => n.id));
    if (known.current === null) { known.current = ids; return; }
    const added = [...ids].filter((id) => !known.current!.has(id));
    known.current = ids;
    if (added.length === 0) return;
    setFresh(new Set(added));
    const timer = setTimeout(() => setFresh(new Set()), 900);
    return () => clearTimeout(timer);
  }, [nodes]);

  return (
    <div className="agents" data-inspecting={selected ? 'true' : 'false'}>
      <div className="agents-graph">
        <Organization
          key={caseId}
          nodes={nodes}
          approvals={approvals}
          events={ws.org.events}
          freshNodeIds={fresh}
          selectedId={nodeId}
          onSelect={(id) => ws.openSection('agents', id)}
        />
      </div>
      {selected && (
        <ErrorBoundary what="This agent's details" key={selected.id}>
          <Inspector
            node={selected}
            approval={approvals.find((a) => a.nodeId === selected.id) ?? null}
            events={ws.org.events}
            onClose={() => ws.openSection('agents', null)}
            onChanged={ws.org.refresh}
          />
        </ErrorBoundary>
      )}
    </div>
  );
}

/** Authority in plain words first — what new work may do, and what it stops
 *  and asks you about — with the full mandate editor one step further. The
 *  runtime holds the mandate; this only shows it and edits what may be edited. */
function AuthorityView() {
  const ws = useWorkspace();
  const [advanced, setAdvanced] = useState(false);
  const mandate = ws.mandates.find((m) => m.id === ws.mandateId) ?? ws.mandates[0] ?? null;
  const envelope = useDaemonQuery<EnvelopeData | null>(
    () => (mandate
      ? daemon().mandate.simulate.query({ authority: mandate.authority, constraints: mandate.constraints })
        .then((result) => (result as { envelope: EnvelopeData }).envelope)
      : Promise.resolve(null)),
    [mandate?.id, JSON.stringify(mandate?.authority), JSON.stringify(mandate?.constraints)],
  );

  return (
    <div className="org-view">
      <div className="org-reading authority">
        <h2 className="authority-title">Workspace authority</h2>
        <p className="surface-note">
          New work here runs under <strong>{mandate?.name ?? 'no mandate'}</strong>. Every run keeps the authority it started with; changing a mandate never rewrites what earlier runs were allowed to do.
        </p>
        {mandate && ws.mandates.length > 1 && (
          <label className="run-picker">
            <span className="sr-only">Mandate for new work</span>
            <select value={mandate.id} onChange={(event) => ws.setMandateId(event.target.value)}>
              {ws.mandates.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
        )}
        {envelope.data ? <Envelope envelope={envelope.data} /> : <p className="surface-empty">Reading what this mandate allows…</p>}
        <button type="button" className="quiet-link" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>
          {advanced ? 'Hide mandate details' : 'Edit mandates — tools, boundaries, spend, delegation'}
        </button>
      </div>
      {advanced && <div className="org-view-wide"><Mandates onChanged={ws.org.refresh} /></div>}
    </div>
  );
}
