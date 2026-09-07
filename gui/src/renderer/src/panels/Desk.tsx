import { useState } from 'react';
import { daemon } from '../lib/client.js';
import { useDaemonQuery } from '../lib/useDaemonQuery.js';
import { WhyPanel } from './WhyPanel.js';
import { LiveStatus } from './LiveStatus.js';
import { Hero } from './Composer.js';
import { ago, money, clip } from '../lib/format.js';
import { toneOf, labelOf } from '../lib/state.js';
import type { OrgNode } from '../lib/useOrg.js';
import type { OrgEvent } from '../lib/eventLog.js';
import type { Mandate } from '../lib/mandates.js';

type AttentionKind = 'approval' | 'over_budget' | 'stalled' | 'interrupted' | 'dod_unmet' | 'denied';

interface AttentionItem {
  kind: AttentionKind;
  nodeId: string;
  caseId: string;
  caseGoal: string;
  nodeGoal: string;
  detail: string;
  approvalId?: string;
  at: string;
}

/** What each signal is called in the window, and how loudly it should read.
 *  Ordering is the daemon's job — it is the same ranking the CLI would use —
 *  so this is only the vocabulary. */
const KINDS: Record<AttentionKind, { label: string; tone: string; verb: string }> = {
  approval: { label: 'Waiting on you', tone: 'at-risk', verb: 'Decide' },
  interrupted: { label: 'Interrupted', tone: 'planning', verb: 'Resume' },
  over_budget: { label: 'Over budget', tone: 'failed', verb: 'Open' },
  denied: { label: 'Refused a tool', tone: 'at-risk', verb: 'Open' },
  dod_unmet: { label: 'Finished incomplete', tone: 'failed', verb: 'Open' },
  stalled: { label: 'Gone quiet', tone: 'planning', verb: 'Open' },
};

interface Props {
  nodes: OrgNode[];
  events: OrgEvent[];
  mandates: Mandate[];
  selectedMandateId: string | null;
  onSelectMandate: (id: string | null) => void;
  onSubmit: (text: string) => Promise<void>;
  onOpenCase: (caseId: string, nodeId?: string) => void;
  onChanged: () => void;
  composerDisabled: boolean;
  blockedReason: string | null;
  revision: number;
}

/** The first screen. Not an inbox of approvals — an inbox of *consequences*:
 *  money already spent past a ceiling, a run that went quiet, one a restart
 *  parked, one that finished without meeting what it promised. Approvals are one
 *  of six things that can need a person, and they were the only one the old
 *  window could show. */
export function Desk(props: Props) {
  const attention = useDaemonQuery<AttentionItem[]>(
    () => daemon().case.attention.query() as Promise<AttentionItem[]>,
    // Counting nodes and events was a weak proxy: a node changing state, or
    // going over budget, moves neither length.
    [props.revision],
  );

  const items = attention.data ?? [];
  const live = props.nodes.filter((node) => !['COMPLETE', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(node.state));

  if (items.length === 0 && live.length === 0) {
    return (
      <div className="desk desk-empty">
        <Hero
          onSubmit={props.onSubmit}
          disabled={props.composerDisabled}
          blockedReason={props.blockedReason}
          mandates={props.mandates}
          selectedMandateId={props.selectedMandateId}
          onSelectMandate={props.onSelectMandate}
          autoFocus
        />
      </div>
    );
  }

  return (
    <div className="desk">
      <header className="desk-head">
        <h1>{items.length === 0 ? 'Nothing needs you' : `${items.length} need${items.length === 1 ? 's' : ''} you`}</h1>
        <p className="sheet-lead">
          Ranked by who is blocked. A decision you owe comes before money already spent,
          which comes before a run that has merely gone quiet.
        </p>
      </header>

      {items.length > 0 && (
        <ul className="attention">
          {items.map((item) => (
            <AttentionRow
              key={`${item.kind}-${item.nodeId}-${item.at}`}
              item={item}
              onOpenCase={props.onOpenCase}
              onChanged={() => { attention.reload(); props.onChanged(); }}
            />
          ))}
        </ul>
      )}

      {live.length > 0 && (
        <section className="desk-live">
          <h2 className="section-title">Running now</h2>
          <LiveStatus nodes={live} events={props.events} />
          <ul className="desk-live-list">
            {live.filter((node) => !node.parentId).map((node) => (
              <li key={node.id}>
                <button type="button" className="desk-live-row" onClick={() => props.onOpenCase(node.id)}>
                  <span className="pill" style={{ ['--state' as string]: `var(--${toneOf(node.state)})` }}>
                    {labelOf(node.state)}
                  </span>
                  <span className="desk-live-goal">{clip(node.goal, 70)}</span>
                  <span className="figure">{money(node.costUsd)} / {money(node.contract.authority.budget_usd)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function AttentionRow(props: {
  item: AttentionItem;
  onOpenCase: (caseId: string, nodeId?: string) => void;
  onChanged: () => void;
}) {
  const { item } = props;
  const kind = KINDS[item.kind];
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      props.onChanged();
    } catch (err) {
      // The daemon refuses an approval whose node could not be restored. Saying
      // so beats a button that silently does nothing.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const primary = () => {
    if (item.kind === 'approval') setOpen((current) => !current);
    else if (item.kind === 'interrupted') void act(() => daemon().node.resume.mutate({ nodeId: item.nodeId }));
    else props.onOpenCase(item.caseId, item.nodeId);
  };

  return (
    <li className="attention-item" style={{ ['--state' as string]: `var(--${kind.tone})` }}>
      <div className="attention-row">
        <span className="attention-dot" aria-hidden="true" />
        <div className="attention-text">
          <p className="attention-detail">{item.detail}</p>
          <p className="attention-meta">
            <button type="button" className="linkish" onClick={() => props.onOpenCase(item.caseId, item.nodeId)}>
              {clip(item.caseGoal, 60)}
            </button>
            {item.nodeGoal !== item.caseGoal && <span className="attention-node"> · {clip(item.nodeGoal, 40)}</span>}
            <span className="figure attention-when"> · {ago(item.at)}</span>
          </p>
        </div>
        <span className="pill">{kind.label}</span>
        <button type="button" className="attention-act" disabled={busy} onClick={primary}>
          {busy ? '…' : kind.verb}
        </button>
      </div>

      {error && <p className="inbox-error">{error}</p>}
      {open && item.approvalId && (
        <ApprovalDetail approvalId={item.approvalId} onChanged={props.onChanged} busy={busy} onAct={act} />
      )}
    </li>
  );
}

interface Detail {
  approval: { id: string; reason: string };
  node: { id: string; goal: string } | null;
  trigger: { id: string; type: string; outcome: string; breakdown: Record<string, number>; createdAt: string } | null;
  requestedUsd: number;
  availableUsd: number;
  spentUsd: number;
}

function ApprovalDetail(props: {
  approvalId: string;
  onChanged: () => void;
  busy: boolean;
  onAct: (run: () => Promise<unknown>) => Promise<void>;
}) {
  const detail = useDaemonQuery<Detail>(
    () => daemon().approval.get.query({ id: props.approvalId }) as Promise<Detail>,
    [props.approvalId],
  );

  if (detail.error) return <p className="inbox-error">{detail.error}</p>;
  if (!detail.data) return null;
  const d = detail.data;

  return (
    <div className="attention-detail">
      <ul className="facts">
        <li><span>Asking for</span><span className="figure">{money(d.requestedUsd)}</span></li>
        <li><span>Its own authority</span><span className="figure">{money(d.availableUsd)}</span></li>
        <li><span>Spent so far</span><span className="figure">{money(d.spentUsd, 4)}</span></li>
      </ul>

      {d.trigger && (
        <>
          <h3 className="inbox-why">Why it stopped here</h3>
          <WhyPanel decision={d.trigger} />
        </>
      )}

      <div className="inspect-actions">
        <button
          type="button"
          className="approve"
          disabled={props.busy}
          onClick={() => void props.onAct(() =>
            daemon().node.resolveApproval.mutate({ approvalId: props.approvalId, decision: 'approved' }))}
        >
          Approve
        </button>
        <button
          type="button"
          className="reject"
          disabled={props.busy}
          onClick={() => void props.onAct(() =>
            daemon().node.resolveApproval.mutate({ approvalId: props.approvalId, decision: 'rejected' }))}
        >
          Reject
        </button>
      </div>
    </div>
  );
}
