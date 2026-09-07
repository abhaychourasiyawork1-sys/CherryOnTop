import { useEffect, useMemo, useRef, useState } from 'react';
import { daemon } from './lib/client.js';
import { useOrg } from './lib/useOrg.js';
import { useDaemonQuery } from './lib/useDaemonQuery.js';
import { subtreeOf } from './lib/tasks.js';
import { Nav } from './shell/Nav.js';
import { Composer, Hero } from './panels/Composer.js';
import { Conversation, type AskExchange, type AskResult } from './panels/Conversation.js';
import { Inspector } from './panels/Inspector.js';
import { Desk } from './panels/Desk.js';
import { Cases } from './panels/Cases.js';
import { Mandates } from './panels/Mandates.js';
import { Memory } from './panels/Memory.js';
import { Organization } from './panels/Organization.js';
import { CaseHeader, type CaseFile } from './panels/CaseHeader.js';
import { Proof } from './panels/Proof.js';
import { Receipt } from './panels/Receipt.js';
import { sectionOf, type CaseTab, type View } from './lib/view.js';
import { ErrorBoundary } from './shell/ErrorBoundary.js';
import { missingRouters, outOfDateMessage } from './lib/compat.js';
import type { Mandate } from './lib/mandates.js';
import type { CustodyChain } from './panels/Custody.js';
// The runtime's own parser, imported rather than reimplemented: the composer
// must split questions from goals exactly the way org.ask will, or it would ask
// the record something the record does not recognize — or worse, start a run.
import { parseQuestion } from '../../../../src/intelligence/ask.js';

interface RepoInfo {
  path: string | null;
  container: string | null;
  error: string | null;
}

declare global {
  interface Window {
    mission?: {
      notifyApprovalPending: (message: string) => void;
      repo: RepoInfo;
      /** Writes a receipt to a file the user picks. Absent when the window is
       *  opened outside Electron. */
      exportReceipt?: (caseId: string, html: string) => Promise<string | null>;
    };
  }
}

// Opened outside Electron (a plain browser during development) there is no
// bridge, and therefore no repository.
const REPO: RepoInfo = window.mission?.repo ?? { path: null, container: null, error: null };

const CASE_TABS: { id: CaseTab; label: string; hint: string }[] = [
  { id: 'conversation', label: 'Conversation', hint: 'What each agent said, as it said it' },
  { id: 'organization', label: 'Organization', hint: 'Who delegated to whom, and its history' },
  { id: 'proof', label: 'Proof', hint: 'Every decision, artifact, refusal and human call' },
  { id: 'receipt', label: 'Receipt', hint: 'The whole case as one shareable object' },
];

export function App() {
  const org = useOrg();
  const [view, setView] = useState<View>({ name: 'desk' });
  const [exchanges, setExchanges] = useState<AskExchange[]>([]);
  const [mandateId, setMandateId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  const mandates = useDaemonQuery<Mandate[]>(
    () => daemon().mandate.list.query() as Promise<Mandate[]>,
    [],
  );

  // Default to the everyday mandate rather than whichever row came back first,
  // so a new user's first run is the sensible one and not an accident of order.
  useEffect(() => {
    if (mandateId || !mandates.data?.length) return;
    setMandateId(mandates.data.find((m) => m.id === 'builtin-focused-change')?.id ?? mandates.data[0].id);
  }, [mandates.data, mandateId]);

  const caseId = view.name === 'case' ? view.id : null;
  const selectedNodeId = view.name === 'case' ? view.nodeId : null;

  const scoped = useMemo(
    () => (caseId ? subtreeOf(org.nodes, caseId) : []),
    [org.nodes, caseId],
  );
  const scopedApprovals = useMemo(() => {
    const ids = new Set(scoped.map((node) => node.id));
    return org.approvals.filter((approval) => ids.has(approval.nodeId));
  }, [org.approvals, scoped]);
  const task = useMemo(
    () => org.nodes.find((node) => node.id === caseId) ?? null,
    [org.nodes, caseId],
  );
  const selectedNode = useMemo(
    () => scoped.find((node) => node.id === selectedNodeId) ?? null,
    [scoped, selectedNodeId],
  );

  // A node counts as fresh for one beat after it appears, which drives the one
  // spawn animation in the graph.
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    const ids = new Set(org.nodes.map((node) => node.id));
    if (known.current === null) { known.current = ids; return; }
    const added = [...ids].filter((id) => !known.current!.has(id));
    known.current = ids;
    if (added.length === 0) return;
    setFresh(new Set(added));
    const timer = setTimeout(() => setFresh(new Set()), 900);
    return () => clearTimeout(timer);
  }, [org.nodes]);

  // Native notification when something starts waiting on a human and the window
  // is not focused — the whole reason the Desk is persistent.
  const notified = useRef(new Set<string>());
  useEffect(() => {
    for (const approval of org.approvals) {
      if (notified.current.has(approval.id)) continue;
      notified.current.add(approval.id);
      window.mission?.notifyApprovalPending(approval.reason);
    }
  }, [org.approvals]);

  const openCase = (id: string, nodeId?: string) => {
    setView({ name: 'case', id, tab: nodeId ? 'organization' : 'conversation', nodeId: nodeId ?? null });
    setExchanges([]);
    setComposing(false);
  };

  const resolveApproval = async (approvalId: string, decision: 'approved' | 'rejected') => {
    await daemon().node.resolveApproval.mutate({ approvalId, decision });
    org.refresh();
  };

  // One box, two jobs: a question is answered from the record, anything else
  // starts a task. Guessing wrong in either direction is costly — starting a run
  // because someone asked a question would be much worse than the reverse — so
  // the split is an explicit parser, not a heuristic.
  const submit = async (text: string) => {
    if (task && parseQuestion(text).intent !== 'unknown') {
      const result = await daemon().org.ask.query({
        question: text,
        // "this" means whatever you are actually looking at.
        focusedNodeId: selectedNodeId ?? task.id,
      });
      setExchanges((current) => [
        ...current,
        { key: `${current.length}-${text}`, question: text, result: result as AskResult },
      ]);
      return;
    }

    const created = await daemon().node.create.mutate({
      goal: text,
      definition_of_done: [text],
      // Sent because the contract requires it; the daemon replaces it with the
      // mandate's own authority, so the two can never disagree.
      authority: { tools: [], spawn_children: true, max_child_count: 3, budget_usd: 5 },
      constraints: [],
      mandateId,
      // The sandbox-side path of the repository this window was opened on.
      repoPath: REPO.container,
    });
    openCase((created as { id: string }).id);
    org.refresh();
  };

  const blockedReason = REPO.container === null
    ? (REPO.error ?? 'Open Mission Control from a git repository to start a task.')
    : null;

  // Checked once, from the daemon's own account of what it serves, instead of
  // letting each panel discover it as a 404 and report the daemon as
  // unreachable.
  const stale = org.connected ? missingRouters(org.routers) : [];

  const showInspector = view.name === 'case' && view.tab === 'organization' && selectedNode !== null;
  const running = org.nodes.filter((node) => !node.parentId
    && !['COMPLETE', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(node.state)).length;

  return (
    <div className="shell" data-inspector={showInspector ? 'open' : 'closed'}>
      <Nav
        section={sectionOf(view)}
        onNavigate={(next) => { setView({ name: next }); setComposing(false); }}
        onNewTask={() => { setView({ name: 'desk' }); setComposing(true); }}
        attention={org.approvals.length}
        running={running}
        repoPath={REPO.path}
        repoError={REPO.error}
        connected={org.connected}
      />

      <main className="stage">
        {org.error && <div className="banner">{org.error}</div>}
        {stale.length > 0 && <div className="banner">{outOfDateMessage(stale)}</div>}

        <ErrorBoundary what="This view" key={sectionOf(view) + (view.name === 'case' ? view.id : '')}>
        {composing ? (
          <div className="desk desk-empty">
            <Hero
              onSubmit={submit}
              disabled={!org.connected || REPO.container === null}
              blockedReason={blockedReason}
              mandates={mandates.data ?? []}
              selectedMandateId={mandateId}
              onSelectMandate={setMandateId}
              autoFocus
            />
          </div>
        ) : view.name === 'desk' ? (
          <Desk
            nodes={org.nodes}
            events={org.events}
            mandates={mandates.data ?? []}
            selectedMandateId={mandateId}
            onSelectMandate={setMandateId}
            onSubmit={submit}
            onOpenCase={openCase}
            onChanged={org.refresh}
            composerDisabled={!org.connected || REPO.container === null}
            blockedReason={blockedReason}
            revision={org.revision}
          />
        ) : view.name === 'cases' ? (
          <Cases onOpenCase={openCase} revision={org.revision} />
        ) : view.name === 'mandates' ? (
          <Mandates onChanged={() => mandates.reload()} />
        ) : view.name === 'memory' ? (
          <Memory onChanged={org.refresh} revision={org.revision} />
        ) : task && view.name === 'case' ? (
          <CaseView
            view={view}
            task={task}
            nodes={scoped}
            approvals={scopedApprovals}
            events={org.events}
            exchanges={exchanges}
            fresh={fresh}
            mandates={mandates.data ?? []}
            mandateId={mandateId}
            onSelectMandate={setMandateId}
            onTab={(tab) => setView({ ...view, tab })}
            onSelectNode={(nodeId) => setView({ ...view, tab: 'organization', nodeId })}
            onOpenCase={openCase}
            onResolveApproval={resolveApproval}
            onSubmit={submit}
            connected={org.connected}
            blockedReason={blockedReason}
            onChanged={org.refresh}
            revision={org.revision}
          />
        ) : (
          <div className="graph-empty">
            <h1>That case is not here.</h1>
            <p>It may have been from another repository. Cases lists everything this daemon knows about.</p>
          </div>
        )}
        </ErrorBoundary>
      </main>

      {showInspector && selectedNode && (
        <ErrorBoundary what="This agent's details" key={selectedNode.id}>
          <Inspector
            node={selectedNode}
            approval={org.approvals.find((approval) => approval.nodeId === selectedNode.id) ?? null}
            events={org.events}
            onClose={() => setView({ ...view, nodeId: null } as View)}
            onChanged={org.refresh}
          />
        </ErrorBoundary>
      )}
    </div>
  );
}

function CaseView(props: {
  view: Extract<View, { name: 'case' }>;
  task: NonNullable<ReturnType<typeof useOrg>['nodes'][number]>;
  nodes: ReturnType<typeof useOrg>['nodes'];
  approvals: ReturnType<typeof useOrg>['approvals'];
  events: ReturnType<typeof useOrg>['events'];
  exchanges: AskExchange[];
  fresh: Set<string>;
  mandates: Mandate[];
  mandateId: string | null;
  onSelectMandate: (id: string | null) => void;
  onTab: (tab: CaseTab) => void;
  onSelectNode: (nodeId: string) => void;
  onOpenCase: (id: string) => void;
  onResolveApproval: (approvalId: string, decision: 'approved' | 'rejected') => Promise<void>;
  onSubmit: (text: string) => Promise<void>;
  connected: boolean;
  blockedReason: string | null;
  onChanged: () => void;
  revision: number;
}) {
  const { view, task } = props;

  // Agents still going anywhere in this case — what "stop the task" would end.
  const running = props.nodes.filter(
    (node) => !['COMPLETE', 'FAILED', 'CANCELLED'].includes(node.state),
  ).length;

  const file = useDaemonQuery<CaseFile>(
    () => daemon().case.file.query({ id: task.id }) as Promise<CaseFile>,
    [task.id, props.revision],
  );

  // Proof and Receipt read the whole case at once rather than deriving it from
  // the live tree: a ledger assembled from two different reads can show a
  // decision whose artifact has not arrived yet, which looks like a gap in the
  // record rather than a gap in the read.
  const proof = useDaemonQuery<{
    decisions: { id: string; nodeId: string; type: string; outcome: string; breakdown: Record<string, number>; createdAt: string }[];
    artifacts: { id: string; nodeId: string; kind: string; path: string | null; summary: string; createdAt: string }[];
    approvals: { id: string; nodeId: string; reason: string; status: string; createdAt: string; resolvedAt?: string }[];
    custody: { nodeId: string; chain: CustodyChain }[];
  }>(
    () => daemon().case.receipt.query({ id: task.id }) as never,
    [task.id, props.revision],
  );

  const [replaying, setReplaying] = useState(false);

  const replay = async () => {
    setReplaying(true);
    try {
      const created = await daemon().node.replay.mutate({ nodeId: task.id, mandateId: props.mandateId });
      props.onOpenCase((created as { id: string }).id);
      props.onChanged();
    } finally {
      setReplaying(false);
    }
  };

  return (
    <>
      {file.data && (
        <CaseHeader
          file={file.data}
          running={running}
          onReplay={replaying ? undefined : () => void replay()}
          onStopped={props.onChanged}
        />
      )}

      <nav className="tabs tabs-case" aria-label="Views of this case">
        {CASE_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-current={view.tab === tab.id}
            title={tab.hint}
            onClick={() => props.onTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {view.tab === 'conversation' && (
        <Conversation
          task={task}
          nodes={props.nodes}
          events={props.events}
          approvals={props.approvals}
          exchanges={props.exchanges}
          revision={props.revision}
          onOpenNode={props.onSelectNode}
          onResolveApproval={props.onResolveApproval}
        />
      )}

      {view.tab === 'organization' && (
        <Organization
          nodes={props.nodes}
          approvals={props.approvals}
          events={props.events}
          freshNodeIds={props.fresh}
          selectedId={view.nodeId}
          onSelect={props.onSelectNode}
        />
      )}

      {view.tab === 'proof' && (
        <div className="sheet sheet-scroll">
          <Proof
            nodes={props.nodes}
            events={props.events}
            decisions={proof.data?.decisions ?? []}
            artifacts={proof.data?.artifacts ?? []}
            approvals={proof.data?.approvals ?? []}
            custody={Object.fromEntries((proof.data?.custody ?? []).map((c) => [c.nodeId, c.chain]))}
            onOpenNode={props.onSelectNode}
          />
        </div>
      )}

      {view.tab === 'receipt' && (
        <div className="sheet sheet-scroll">
          <Receipt caseId={task.id} onOpenNode={props.onSelectNode} revision={props.revision} />
        </div>
      )}

      {(view.tab === 'conversation' || view.tab === 'organization') && (
        <Composer
          onSubmit={props.onSubmit}
          disabled={!props.connected}
          variant="docked"
          blockedReason={props.blockedReason}
          mandates={props.mandates}
          selectedMandateId={props.mandateId}
          onSelectMandate={props.onSelectMandate}
        />
      )}
    </>
  );
}
