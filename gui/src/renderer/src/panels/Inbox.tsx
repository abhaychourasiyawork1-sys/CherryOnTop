import { useEffect, useState } from 'react';
import { daemon } from '../lib/client.js';
import { WhyPanel } from './WhyPanel.js';
import type { Approval } from '../lib/useOrg.js';

interface Detail {
  approval: Approval;
  node: { id: string; goal: string; contract: { authority: { budget_usd: number } } } | null;
  trigger: { id: string; type: string; outcome: string; breakdown: Record<string, number>; createdAt: string } | null;
  requestedUsd: number;
  availableUsd: number;
  spentUsd: number;
}

interface Props {
  approvals: Approval[];
  onChanged: () => void;
  onReveal: (nodeId: string) => void;
}

export function Inbox(props: Props) {
  const [openId, setOpenId] = useState<string | null>(props.approvals[0]?.id ?? null);

  if (props.approvals.length === 0) {
    return (
      <div className="sheet">
        <div className="graph-empty">
          <h1>Nothing needs you.</h1>
          <p>
            When an agent reaches the edge of its authority it stops and asks here, with
            the scored decision that took it there.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="sheet">
      <h1 className="sheet-title">Waiting on you</h1>
      <ul className="inbox">
        {props.approvals.map((approval) => (
          <li key={approval.id}>
            <button
              type="button"
              className="inbox-row"
              aria-expanded={openId === approval.id}
              onClick={() => setOpenId(openId === approval.id ? null : approval.id)}
            >
              <span className="inbox-dot" />
              <span>{approval.reason}</span>
              <span className="figure inbox-when">{when(approval.createdAt)}</span>
            </button>
            {openId === approval.id && (
              <ApprovalDetail
                approvalId={approval.id}
                onChanged={props.onChanged}
                onReveal={props.onReveal}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ApprovalDetail(props: { approvalId: string; onChanged: () => void; onReveal: (id: string) => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    daemon().approval.get.query({ id: props.approvalId })
      .then((result) => { if (!cancelled) setDetail(result as unknown as Detail); })
      .catch((err: unknown) => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, [props.approvalId]);

  const resolve = async (decision: 'approved' | 'rejected') => {
    setBusy(true);
    setError(null);
    try {
      await daemon().node.resolveApproval.mutate({ approvalId: props.approvalId, decision });
      props.onChanged();
    } catch (err) {
      // The daemon refuses an approval whose node did not survive a restart.
      // Saying so beats a button that silently does nothing.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (error && !detail) return <p className="inbox-error">{error}</p>;
  if (!detail) return null;

  return (
    <div className="inbox-detail">
      {detail.node && (
        <button type="button" className="inbox-goal" onClick={() => props.onReveal(detail.node!.id)}>
          {detail.node.goal}
        </button>
      )}

      <ul className="facts">
        <li>
          <span>Requesting</span>
          <span className="figure">${detail.requestedUsd.toFixed(2)}</span>
        </li>
        <li>
          <span>Its own authority</span>
          <span className="figure">${detail.availableUsd.toFixed(2)}</span>
        </li>
        <li>
          <span>Spent so far</span>
          <span className="figure">${detail.spentUsd.toFixed(4)}</span>
        </li>
      </ul>

      {detail.trigger && (
        <>
          <h3 className="inbox-why">Why it stopped here</h3>
          <WhyPanel decision={detail.trigger} />
        </>
      )}

      {error && <p className="inbox-error">{error}</p>}

      <div className="inspect-actions">
        <button type="button" className="approve" disabled={busy} onClick={() => void resolve('approved')}>
          Approve
        </button>
        <button type="button" className="reject" disabled={busy} onClick={() => void resolve('rejected')}>
          Reject
        </button>
      </div>
    </div>
  );
}

function when(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}
