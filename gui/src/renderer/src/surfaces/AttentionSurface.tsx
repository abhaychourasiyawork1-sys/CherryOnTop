import { useState } from 'react';
import { daemon } from '../lib/client.js';
import { useDaemonQuery } from '../lib/useDaemonQuery.js';
import { WhyPanel } from '../panels/WhyPanel.js';
import { groupAttention, type AttentionGroup, type AttentionItem } from '../lib/attention.js';
import { titleOf } from '../lib/run.js';
import { ago, money } from '../lib/format.js';

export function useAttention(revision: number) {
  return useDaemonQuery<AttentionItem[]>(() => daemon().case.attention.query() as Promise<AttentionItem[]>, [revision]);
}

interface Props {
  items: AttentionItem[];
  /** Takes the person to the run (and agent) this is about. */
  onOpen: (caseId: string, nodeId?: string) => void;
  onChanged: () => void;
}

/** What needs a person, grouped, and what is merely worth knowing, kept
 *  separate and quiet. Acting here resolves it; the runtime carries on by
 *  itself where it can. */
export function AttentionSurface(props: Props) {
  const groups = groupAttention(props.items);
  const needs = groups.filter((group) => group.level === 'attention');
  const inform = groups.filter((group) => group.level === 'inform');
  const [showInform, setShowInform] = useState(needs.length === 0);

  if (groups.length === 0) {
    return <p className="surface-empty">Nothing needs you. Work that can continue on its own is continuing.</p>;
  }

  return (
    <div className="attention2">
      {needs.length > 0 && (
        <ul className="attention-groups">
          {needs.map((group) => <Group key={group.key} group={group} onOpen={props.onOpen} onChanged={props.onChanged} />)}
        </ul>
      )}

      {inform.length > 0 && (
        <section className="attention-inform">
          <button type="button" className="quiet-link" aria-expanded={showInform} onClick={() => setShowInform((v) => !v)}>
            {showInform ? 'Hide' : 'Show'} {inform.length} for your information
          </button>
          {showInform && (
            <ul className="attention-groups">
              {inform.map((group) => <Group key={group.key} group={group} onOpen={props.onOpen} onChanged={props.onChanged} />)}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function Group({ group, onOpen, onChanged }: { group: AttentionGroup; onOpen: Props['onOpen']; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const first = group.items[0];
  const resumable = group.kind === 'interrupted';

  return (
    <li className="attention-group" data-level={group.level} data-type={group.type}>
      <p className="attention-title">{group.title}</p>
      <p className="attention-detail2">{group.detail}</p>
      <p className="attention-where">
        {group.caseIds.length === 1 ? (
          <button type="button" className="quiet-link" onClick={() => onOpen(first.caseId, first.nodeId)}>{titleOf(first.caseGoal)}</button>
        ) : (
          <button type="button" className="quiet-link" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Hide' : 'Show'} the {group.caseIds.length} runs
          </button>
        )}
        <span className="attention-when">{ago(group.at)}</span>
      </p>
      {expanded && (
        <ul className="attention-runs">
          {group.caseIds.map((caseId) => {
            const item = group.items.find((i) => i.caseId === caseId)!;
            return (
              <li key={caseId}>
                <button type="button" className="quiet-link" onClick={() => onOpen(caseId, item.nodeId)}>{titleOf(item.caseGoal)}</button>
              </li>
            );
          })}
        </ul>
      )}
      {group.kind === 'approval' && first.approvalId && (
        <ApprovalDetail approvalId={first.approvalId} busy={busy} onAct={act} />
      )}
      {resumable && (
        <div className="reply-actions">
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() => void act(() => Promise.all(group.items.map((item) => daemon().node.resume.mutate({ nodeId: item.nodeId }))))}
          >
            {busy ? 'Resuming…' : group.items.length === 1 ? 'Resume' : `Resume all ${group.items.length}`}
          </button>
        </div>
      )}
      {error && <p className="inline-error">{error}</p>}
    </li>
  );
}

interface Detail {
  trigger: { id: string; type: string; outcome: string; breakdown: Record<string, number>; createdAt: string } | null;
  requestedUsd: number;
  availableUsd: number;
  spentUsd: number;
}

function ApprovalDetail(props: { approvalId: string; busy: boolean; onAct: (run: () => Promise<unknown>) => Promise<void> }) {
  const detail = useDaemonQuery<Detail>(() => daemon().approval.get.query({ id: props.approvalId }) as Promise<Detail>, [props.approvalId]);
  const [why, setWhy] = useState(false);
  if (detail.error) return <p className="inline-error">{detail.error}</p>;
  const d = detail.data;
  return (
    <div className="approval-detail">
      {d && (
        <dl className="decision-facts">
          <div><dt>Asking for</dt><dd className="figure">{money(d.requestedUsd)}</dd></div>
          <div><dt>Its authority</dt><dd className="figure">{money(d.availableUsd)}</dd></div>
          <div><dt>Spent so far</dt><dd className="figure">{money(d.spentUsd, 2)}</dd></div>
        </dl>
      )}
      <div className="reply-actions">
        <button type="button" className="button primary" disabled={props.busy}
          onClick={() => void props.onAct(() => daemon().node.resolveApproval.mutate({ approvalId: props.approvalId, decision: 'approved' }))}>
          Approve
        </button>
        <button type="button" className="button" disabled={props.busy}
          onClick={() => void props.onAct(() => daemon().node.resolveApproval.mutate({ approvalId: props.approvalId, decision: 'rejected' }))}>
          Decline
        </button>
        {d?.trigger && <button type="button" className="quiet-link" aria-expanded={why} onClick={() => setWhy((v) => !v)}>Why it stopped</button>}
      </div>
      {why && d?.trigger && <WhyPanel decision={d.trigger} />}
    </div>
  );
}
