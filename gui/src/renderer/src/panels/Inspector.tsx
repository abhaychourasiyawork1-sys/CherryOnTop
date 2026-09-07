import { useEffect, useMemo, useState } from 'react';
import { daemon } from '../lib/client.js';
import { toneOf, labelOf, isTerminal } from '../lib/state.js';
import { toLines } from '../lib/transcript.js';
import { WhyPanel } from './WhyPanel.js';
import { Markdown } from './Markdown.js';
import { Custody, type CustodyChain } from './Custody.js';
import { DodList, type DodItem } from './DodList.js';
import { Envelope } from './Envelope.js';
import { useDaemonQuery } from '../lib/useDaemonQuery.js';
import { money } from '../lib/format.js';
import type { Envelope as EnvelopeData } from '../lib/mandates.js';
import type { OrgNode, Approval } from '../lib/useOrg.js';
import type { OrgEvent } from '../lib/eventLog.js';

interface Commitment {
  id: string;
  goal: string;
  definition_of_done: string[];
  status: string;
  evidence: string[];
  risks: string[];
}

interface Detail {
  node: OrgNode;
  commitments: Commitment[];
  decisions: { id: string; type: string; outcome: string; breakdown: Record<string, number>; createdAt: string }[];
  artifacts: { id: string; kind: string; path: string | null; summary: string; createdAt: string }[];
  children: OrgNode[];
  costUsd: number;
  budgetHealth: number;
  pendingApproval: Approval | null;
  /** What this node answered. The conversation shows children in outline, so
   *  this panel is where their full reply lives. */
  answer: string | null;
  /** Optional on purpose. The daemon is a separate process built separately,
   *  and `org gui` reuses whatever daemon is already running — so these fields
   *  are genuinely absent when the daemon predates them. Typing them as required
   *  is what let an unguarded read blank the whole window. */
  dod?: { items: DodItem[]; progress: { met: number; unmet: number; unverified: number; total: number } };
  envelope?: EnvelopeData;
  summary?: string;
}

type Tab = 'answer' | 'overview' | 'checks' | 'decisions' | 'evidence' | 'activity';

const TABS: { id: Tab; label: string }[] = [
  { id: 'answer', label: 'Answer' },
  { id: 'overview', label: 'Overview' },
  { id: 'checks', label: 'Checks' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'activity', label: 'Activity' },
];

interface Props {
  node: OrgNode;
  approval: Approval | null;
  events: OrgEvent[];
  onClose: () => void;
  onChanged: () => void;
}

export function Inspector(props: Props) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nodeId = props.node.id;

  // Re-read whenever the node's own state moves, so spend, evidence and
  // decisions stay current without a second subscription.
  useEffect(() => {
    let cancelled = false;
    daemon().node.detail.query({ id: nodeId })
      .then((result) => { if (!cancelled) setDetail(result as unknown as Detail); })
      .catch(() => { if (!cancelled) setDetail(null); });
    return () => { cancelled = true; };
  }, [nodeId, props.node.state, props.node.updatedAt]);

  // Reset to Overview when a different node is selected — landing on whatever
  // tab was open for the previous one is disorienting.
  // Land on the answer when there is one — it is what the node was for.
  useEffect(() => { setTab('overview'); setError(null); }, [nodeId]);
  useEffect(() => { if (detail?.answer) setTab('answer'); }, [detail?.answer]);

  const tone = props.approval ? 'at-risk' : toneOf(props.node.state);
  const lines = useMemo(() => toLines(props.events, nodeId), [props.events, nodeId]);
  const custody = useDaemonQuery<CustodyChain>(
    () => daemon().case.custody.query({ nodeId }) as Promise<CustodyChain>,
    [nodeId],
  );
  // Tool calls this node's mandate refused. Rare by design, and the single most
  // important thing in the panel when it is not.
  const denials = useMemo(
    () => props.events.filter((event) => event.nodeId === nodeId && event.type === 'authority.denied'),
    [props.events, nodeId],
  );

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      props.onChanged();
    } catch (err) {
      // The daemon refuses an approval whose node did not survive a restart.
      // Saying so beats a button that silently does nothing.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="inspector" style={{ ['--state' as string]: `var(--${tone})` }}>
      <header className="inspect-head">
        <span className="node-state">{labelOf(props.node.state)}</span>
        <button type="button" onClick={props.onClose} aria-label="Close details">✕</button>
      </header>

      <h2 className="inspect-goal">{props.node.goal}</h2>
      <p className="inspect-id figure">{nodeId}</p>

      {custody.data && <Custody chain={custody.data} />}

      {denials.length > 0 && (
        <section className="inspect-denials">
          <h3>Its mandate refused {denials.length} tool call{denials.length === 1 ? '' : 's'}</h3>
          <ul className="facts">
            {denials.map((event, index) => (
              <li key={event.id ?? index}>
                <span className="figure">{String((event.payload as { tool?: string } | null)?.tool ?? 'a tool')}</span>
                <span className="ink-faint">not granted</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {props.approval && (
        <section className="inspect-approval">
          <p>{props.approval.reason}</p>
          <div className="inspect-actions">
            <button
              type="button"
              className="approve"
              disabled={busy}
              onClick={() => void act(() => daemon().node.resolveApproval.mutate({ approvalId: props.approval!.id, decision: 'approved' }))}
            >
              Approve
            </button>
            <button
              type="button"
              className="reject"
              disabled={busy}
              onClick={() => void act(() => daemon().node.resolveApproval.mutate({ approvalId: props.approval!.id, decision: 'rejected' }))}
            >
              Reject
            </button>
          </div>
        </section>
      )}

      {error && <p className="inbox-error">{error}</p>}

      <nav className="tabs tabs-inspector" aria-label="Details">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-current={tab === entry.id}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
            {entry.id === 'checks' && detail?.dod && detail.dod.progress.total > 0 && (
              <span className="tab-count figure">
                {detail.dod.progress.met}/{detail.dod.progress.total}
              </span>
            )}
            {entry.id === 'decisions' && detail && detail.decisions.length > 0 && (
              <span className="tab-count figure">{detail.decisions.length}</span>
            )}
            {entry.id === 'evidence' && detail && detail.artifacts.length > 0 && (
              <span className="tab-count figure">{detail.artifacts.length}</span>
            )}
          </button>
        ))}
      </nav>

      {tab === 'answer' && (
        detail?.answer
          ? <div className="inspect-answer"><Markdown source={detail.answer} /></div>
          : <p className="tab-empty">No answer yet. It appears here when this agent finishes.</p>
      )}
      {tab === 'overview' && <Overview node={props.node} detail={detail} />}
      {tab === 'checks' && (
        detail?.dod
          ? <DodList items={detail.dod.items} editable onChanged={props.onChanged} />
          : <p className="tab-empty">No checks are recorded for this agent.</p>
      )}
      {tab === 'decisions' && <Decisions detail={detail} />}
      {tab === 'evidence' && <Evidence detail={detail} />}
      {tab === 'activity' && <ActivityTab lines={lines} />}

      {!isTerminal(props.node.state) && (
        <button
          type="button"
          className="inspect-stop"
          disabled={busy}
          onClick={() => void act(() => daemon().node.cancel.mutate({ nodeId }))}
        >
          Stop this agent
        </button>
      )}
    </aside>
  );
}

function Overview({ node, detail }: { node: OrgNode; detail: Detail | null }) {
  const authority = node.contract.authority;
  return (
    <>
      <Section title="Spend">
        <div className="budget-meter" aria-hidden="true">
          <span
            className="budget-fill"
            style={{
              width: `${Math.min(node.budgetHealth, 1) * 100}%`,
              background: node.budgetHealth > 1 ? 'var(--failed)' : 'var(--state)',
            }}
          />
        </div>
        <p className="figure inspect-figure">
          ${node.costUsd.toFixed(4)} of ${authority.budget_usd.toFixed(2)} authorized
        </p>
      </Section>

      <Section title="Authority">
        {detail?.envelope
          ? <Envelope envelope={detail.envelope} compact />
          : (
            <ul className="facts">
              <li>
                <span>Delegate</span>
                <span>{authority.spawn_children ? `up to ${authority.max_child_count} agents` : 'not permitted'}</span>
              </li>
              <li><span>Budget</span><span className="figure">{money(authority.budget_usd)}</span></li>
            </ul>
          )}
      </Section>

      {detail && detail.commitments.length > 0 && (
        <Section title="Commitment">
          <ul className="facts">
            {detail.commitments.map((commitment) => (
              <li key={commitment.id}>
                <span>Status</span>
                <span>{commitment.status}</span>
              </li>
            ))}
          </ul>
          {detail.commitments.flatMap((commitment) => commitment.risks).map((risk) => (
            <p key={risk} className="record-risk">{risk}</p>
          ))}
        </Section>
      )}

      {detail && detail.children.length > 0 && (
        <Section title={`Delegated to ${detail.children.length}`}>
          <ul className="children">
            {detail.children.map((child) => (
              <li key={child.id}>
                <span className="node-state" style={{ ['--state' as string]: `var(--${toneOf(child.state)})` }}>
                  {labelOf(child.state)}
                </span>
                <span>{child.goal}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

function Decisions({ detail }: { detail: Detail | null }) {
  if (!detail || detail.decisions.length === 0) {
    return <p className="tab-empty">No scored decision yet. One appears the moment this agent chooses how to run.</p>;
  }
  return (
    <>
      {detail.decisions.slice().reverse().map((decision) => (
        <section key={decision.id} className="inspect-section">
          <h3>{decision.type === 'runtime_selection' ? 'Chose a runtime' : 'Chose how to execute'}</h3>
          <WhyPanel decision={decision} />
        </section>
      ))}
    </>
  );
}

function Evidence({ detail }: { detail: Detail | null }) {
  if (!detail) return null;
  const closing = detail.commitments.flatMap((commitment) => commitment.evidence);
  if (detail.artifacts.length === 0) {
    return <p className="tab-empty">Nothing produced yet. Files written, commands run and results appear here as they happen.</p>;
  }
  return (
    <>
      <Section title={`Produced ${detail.artifacts.length}`}>
        <ul className="artifacts">
          {detail.artifacts.map((artifact) => (
            <li key={artifact.id} data-kind={artifact.kind}>
              <span className="figure">{artifact.path ?? artifact.summary}</span>
            </li>
          ))}
        </ul>
      </Section>
      {closing.length > 0 && (
        <Section title="Closed its commitment">
          <p className="inspect-figure figure">{closing.length} of these were recorded as evidence</p>
        </Section>
      )}
    </>
  );
}

function ActivityTab({ lines }: { lines: ReturnType<typeof toLines> }) {
  if (lines.length === 0) {
    return <p className="tab-empty">No output yet. Once this agent dispatches, its runtime appears here as it works.</p>;
  }
  return (
    <ol className="stream">
      {lines.map((line) => (
        <li key={line.key} data-kind={line.kind}>
          {line.diffLines ? (
            <pre className="diff">
              {line.diffLines.map((diff, index) => (
                <span key={index} data-sign={diff[0] === '+' ? 'add' : diff[0] === '-' ? 'remove' : 'context'}>
                  {diff}
                  {'\n'}
                </span>
              ))}
            </pre>
          ) : (
            <span>{line.content}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="inspect-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
