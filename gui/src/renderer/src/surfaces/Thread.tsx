import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { RunLine } from './RunSurface.js';
import { ResultCard, FailureCard } from './ResultSurface.js';
import { AskAnswer, type AskExchange } from '../panels/Conversation.js';
import { subtreeOf } from '../lib/tasks.js';
import { phaseOf, isLive, titleOf } from '../lib/run.js';
import { caseStamp, useCaseFile } from '../lib/useCase.js';
import { ago, when } from '../lib/format.js';
import { useWorkspace } from '../shell/WorkspaceContext.js';
import { Icon } from '../shell/Icon.js';
import { compose } from '../panels/Composer.js';
import { copyText } from '../panels/Markdown.js';
import { daemon } from '../lib/client.js';
import type { OrgNode, Approval } from '../lib/useOrg.js';

const PAGE = 8;

/** The Workspace conversation: each thing you asked for, and what the
 *  organization did about it, oldest first. Every reply is live — a run in
 *  progress, a result, a failure with its next step — and the full working is
 *  always one level deeper, never inline. */
export function Thread(props: { caseIds: string[]; exchanges: AskExchange[]; empty: React.ReactNode }) {
  const ws = useWorkspace();
  const byId = useMemo(() => new Map(ws.org.nodes.map((node) => [node.id, node])), [ws.org.nodes]);
  const roots = useMemo(
    () => props.caseIds.map((id) => byId.get(id)).filter((n): n is OrgNode => Boolean(n))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [props.caseIds, byId],
  );
  const [shown, setShown] = useState(PAGE);
  const visible = roots.slice(-shown);

  // Follow the tail only when the reader is already at the bottom.
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const tail = `${roots.length}:${props.exchanges.length}:${roots.at(-1)?.updatedAt ?? ''}`;
  useEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [tail]);

  const [awayFromEnd, setAwayFromEnd] = useState(false);

  if (roots.length === 0 && props.exchanges.length === 0) return <>{props.empty}</>;

  return (
    <div className="thread-wrap">
    {awayFromEnd && (
        <button
          type="button"
          className="jump-latest"
          aria-label="Jump to the latest"
          title="Jump to the latest"
          onClick={() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })}
        >
          <Icon name="arrowDown" size={14} />
        </button>
    )}
    <div
      className="thread-scroll"
      ref={scroller}
      onScroll={(event) => {
        const el = event.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        setAwayFromEnd(!pinned.current);
      }}
    >
      <div className="thread2">
        {roots.length > shown && (
          <button type="button" className="thread-earlier" onClick={() => setShown((n) => n + PAGE * 2)}>
            Show {Math.min(roots.length - shown, PAGE * 2)} earlier
          </button>
        )}
        {visible.map((root) => (
          <Exchange
            key={root.id}
            root={root}
            active={ws.activeCase?.id === root.id}
            approvals={ws.org.approvals}
            exchanges={props.exchanges.filter((exchange) => exchange.caseId === root.id)}
          />
        ))}
        {props.exchanges.filter((exchange) => !exchange.caseId).map((exchange) => (
          <AskAnswer key={exchange.key} exchange={exchange} />
        ))}
      </div>
    </div>
    </div>
  );
}

const Exchange = memo(function Exchange(props: {
  root: OrgNode;
  active: boolean;
  approvals: Approval[];
  exchanges: AskExchange[];
}) {
  const ws = useWorkspace();
  const { root } = props;
  const subtree = useMemo(() => subtreeOf(ws.org.nodes, root.id), [ws.org.nodes, root.id]);
  const stamp = caseStamp(subtree);
  const phase = phaseOf(root, subtree);
  const live = isLive(phase);
  // A live run needs nothing from case.file; a settled one needs its answer.
  const file = useCaseFile(live ? null : root.id, stamp);
  const [showGoal, setShowGoal] = useState(false);
  const title = titleOf(root.goal);
  const truncated = root.goal.trim().length > title.length + 2;

  const pending = useMemo(() => {
    const ids = new Set(subtree.map((node) => node.id));
    return props.approvals.filter((approval) => ids.has(approval.nodeId));
  }, [props.approvals, subtree]);

  return (
    <article className="exchange" data-active={props.active} aria-label={title}>
      <header className="ask">
        <p className="ask-text">
          {showGoal ? <span className="ask-full">{root.goal}</span> : title}
        </p>
        <p className="ask-meta">
          <time dateTime={root.createdAt} title={when(root.createdAt)}>{ago(root.createdAt)}</time>
          {truncated && (
            <button type="button" className="quiet-link" onClick={() => setShowGoal((v) => !v)}>
              {showGoal ? 'Show less' : 'Show full request'}
            </button>
          )}
          <button
            type="button"
            className="quiet-link msg-edit"
            title="Put this request back in the composer to change and send as new work"
            onClick={() => compose(root.goal)}
          >
            <Icon name="edit" size={12} /> Edit
          </button>
        </p>
      </header>

      <div
        className="reply"
        onClickCapture={() => { if (!props.active) ws.focusCase(root.id); }}
      >
        {pending.map((approval) => <InlineApproval key={approval.id} approval={approval} />)}
        {live ? (
          <RunLine
            root={root}
            subtree={subtree}
            phase={phase}
            events={ws.org.events}
            onWatch={() => ws.surfaces.open('run', root.id)}
            onPlan={() => ws.surfaces.open('plan', root.id)}
            onStopped={ws.org.refresh}
          />
        ) : phase === 'done' ? (
          <ResultCard root={root} file={file.data} stamp={stamp} />
        ) : (
          <FailureCard root={root} subtree={subtree} file={file.data} stamp={stamp} />
        )}
        {!live && <MessageActions root={root} answer={file.data?.answer ?? null} />}
      </div>

      {props.exchanges.map((exchange) => <AskAnswer key={exchange.key} exchange={exchange} />)}
    </article>
  );
});

/** The small row every chat reply has: copy it, run it again, take it
 *  somewhere new. Quiet until you look for it. */
function MessageActions({ root, answer }: { root: OrgNode; answer: string | null }) {
  const ws = useWorkspace();
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const again = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await daemon().node.replay.mutate({ nodeId: root.id, mandateId: ws.mandateId });
      ws.org.refresh();
      ws.focusCase((created as { id: string }).id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="msg-actions" role="toolbar" aria-label="Reply actions">
      {answer && (
        <button
          type="button"
          className="icon-button"
          aria-label={copied === 'yes' ? 'Copied' : 'Copy the answer'}
          title={copied === 'yes' ? 'Copied' : copied === 'no' ? 'Could not copy' : 'Copy the answer'}
          onClick={() => void copyText(answer).then((ok) => { setCopied(ok ? 'yes' : 'no'); setTimeout(() => setCopied(null), 1500); })}
        >
          <Icon name={copied === 'yes' ? 'check' : 'copy'} size={14} />
        </button>
      )}
      {!ws.blockedReason && (
        <button type="button" className="icon-button" aria-label="Run this request again" title="Run again" disabled={busy} onClick={() => void again()}>
          <Icon name="refresh" size={14} />
        </button>
      )}
      {error && <span className="inline-error">{error}</span>}
    </div>
  );
}

/** An approval, answerable where it is read. The runtime continues on its own
 *  once it is answered. */
function InlineApproval({ approval }: { approval: Approval }) {
  const ws = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolve = async (decision: 'approved' | 'rejected') => {
    setBusy(true);
    setError(null);
    try {
      await ws.resolveApproval(approval.id, decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="approval-inline" role="group" aria-label="Needs your decision">
      <p className="approval-reason">{approval.reason}</p>
      <p className="approval-note">This is outside what the current mandate allows. Work continues once you decide.</p>
      {error && <p className="inline-error">{error}</p>}
      <div className="reply-actions">
        <button type="button" className="button primary" disabled={busy} onClick={() => void resolve('approved')}>Approve</button>
        <button type="button" className="button" disabled={busy} onClick={() => void resolve('rejected')}>Decline</button>
      </div>
    </div>
  );
}
