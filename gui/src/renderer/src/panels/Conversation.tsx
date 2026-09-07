import { useEffect, useMemo, useRef, useState } from 'react';
import { Turn } from './Turn.js';
import { WhyPanel } from './WhyPanel.js';
import { LiveStatus } from './LiveStatus.js';
import { Markdown } from './Markdown.js';
import { toTurns } from '../lib/transcript.js';
import { depths } from '../lib/tasks.js';
import { agentName } from '../lib/agentName.js';
import { daemon } from '../lib/client.js';
import { useDaemonQuery } from '../lib/useDaemonQuery.js';
import { mergeEvents } from '../lib/eventLog.js';
import type { OrgNode, Approval } from '../lib/useOrg.js';
import type { OrgEvent } from '../lib/eventLog.js';

/** An org.ask answer. Every field is a row the runtime already wrote, so the
 *  answer renders as the record that backs it rather than as prose about it. */
export interface AskResult {
  intent: 'why' | 'blocking' | 'cost' | 'evidence' | 'unknown';
  answer: string;
  nodeId?: string;
  goal?: string;
  decisions?: { id: string; type: string; outcome: string; breakdown: Record<string, number>; createdAt: string }[];
  artifacts?: { id: string; kind: string; path: string | null; summary: string }[];
  approvals?: { id: string; nodeId: string; reason: string }[];
  supported?: string[];
}

export interface AskExchange {
  key: string;
  question: string;
  result: AskResult;
}

interface Props {
  task: OrgNode;
  nodes: OrgNode[];
  events: OrgEvent[];
  approvals: Approval[];
  exchanges: AskExchange[];
  /** Bumped when the organization changes, so the history re-reads. */
  revision: number;
  onOpenNode: (nodeId: string) => void;
  onResolveApproval: (approvalId: string, decision: 'approved' | 'rejected') => Promise<void>;
}

/** An approval, answerable where you read about it. The daemon refuses one whose
 *  node did not survive a restart, so the failure has to be visible here —
 *  otherwise the buttons just quietly do nothing. */
function ApprovalTurn(props: {
  approval: Approval;
  speaker: string;
  onResolve: (approvalId: string, decision: 'approved' | 'rejected') => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolve = async (decision: 'approved' | 'rejected') => {
    setBusy(true);
    setError(null);
    try {
      await props.onResolve(props.approval.id, decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="turn turn-approval" data-top="true">
      <span className="turn-speaker turn-speaker-static">
        <span className="turn-dot" aria-hidden="true" />
        <span className="turn-name">{props.speaker}</span>
      </span>
      <div className="turn-body">
        <p className="said">{props.approval.reason}</p>
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
    </article>
  );
}

export function Conversation(props: Props) {
  // This case's own history, loaded when it is opened. The live stream only
  // carries the most recent events across the whole daemon, so on its own it
  // shows a case's transcript for a few minutes and then loses it.
  const history = useDaemonQuery<OrgEvent[]>(
    () => daemon().events.forCase.query({ id: props.task.id }) as Promise<OrgEvent[]>,
    [props.task.id, props.revision],
  );

  const scope = useMemo(() => new Set(props.nodes.map((node) => node.id)), [props.nodes]);
  const depthOf = useMemo(() => depths(props.nodes), [props.nodes]);
  const byId = useMemo(() => new Map(props.nodes.map((node) => [node.id, node])), [props.nodes]);

  // History plus whatever has arrived live since it was read. mergeEvents
  // dedupes on the row id, so an event in both appears once.
  const events = useMemo(
    () => mergeEvents(history.data ?? [], props.events.filter((event) => scope.has(event.nodeId))),
    [history.data, props.events, scope],
  );

  const turns = useMemo(
    () => toTurns(events, depthOf, { omitSummaries: true }),
    [events, depthOf],
  );

  // The root's answer is the thing the reader was waiting for, so it goes above
  // the working rather than at the end of it. It stays in the thread too, in
  // place, so the sequence still reads correctly when you follow it through.
  const finalAnswer = useMemo(
    () => turns.filter((turn) => turn.depth === 0 && turn.answer).at(-1)?.answer ?? null,
    [turns],
  );

  // A stable number per agent, in the order each first appears, so a reader can
  // say "agent 3" and everyone means the same one.
  const numberOf = useMemo(() => {
    const numbers = new Map<string, number>();
    for (const turn of turns) {
      if (!numbers.has(turn.nodeId)) numbers.set(turn.nodeId, numbers.size + 1);
    }
    return numbers;
  }, [turns]);

  // Only the first turn an agent takes carries its name.
  const introduces = useMemo(() => {
    const seen = new Set<string>();
    return turns.map((turn) => {
      if (seen.has(turn.nodeId)) return false;
      seen.add(turn.nodeId);
      return true;
    });
  }, [turns]);

  // Follow the tail, but only when the reader is already at the bottom —
  // yanking the view down while someone is reading back is the worst thing a
  // live transcript can do.
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [turns.length, props.exchanges.length]);

  return (
    <div
      className="conversation"
      ref={scroller}
      onScroll={(scrollEvent) => {
        const element = scrollEvent.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}
    >
      <div className="thread">
        <section className="asked">
          <h2 className="asked-label">You asked</h2>
          <p className="asked-goal">{props.task.goal}</p>
        </section>

        {finalAnswer && (
          <section className="final-answer">
            <h2 className="final-answer-label">The answer</h2>
            <Markdown source={finalAnswer} />
          </section>
        )}

        <h2 className="working-label">
          How it got there
          <span className="figure working-count">
            {numberOf.size} {numberOf.size === 1 ? 'agent' : 'agents'}
          </span>
        </h2>

        {turns.map((turn, index) => (
          <Turn
            key={turn.key}
            turn={turn}
            node={byId.get(turn.nodeId)}
            index={numberOf.get(turn.nodeId) ?? index + 1}
            introduces={introduces[index]}
            onOpenNode={props.onOpenNode}
          />
        ))}

        {props.approvals.map((approval) => (
          <ApprovalTurn
            key={approval.id}
            approval={approval}
            speaker={agentName(byId.get(approval.nodeId)?.goal ?? 'Agent')}
            onResolve={props.onResolveApproval}
          />
        ))}

        {props.exchanges.map((exchange) => (
          <div key={exchange.key}>
            <article className="turn turn-you" data-top="true">
              <div className="turn-body">
                <p className="asked-goal">{exchange.question}</p>
              </div>
            </article>
            <article className="turn turn-answer" data-top="true">
              <div className="turn-body">
                <p className="from-record">From the record</p>
                <Markdown source={exchange.result.answer} />
                {exchange.result.decisions?.slice().reverse().map((decision) => (
                  <WhyPanel key={decision.id} decision={decision} />
                ))}
                {exchange.result.artifacts && exchange.result.artifacts.length > 0 && (
                  <ul className="artifacts">
                    {exchange.result.artifacts.map((artifact) => (
                      <li key={artifact.id} data-kind={artifact.kind}>
                        <span className="figure">{artifact.path ?? artifact.summary}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {exchange.result.supported && (
                  <ul className="answer-supported">
                    {exchange.result.supported.map((example) => (
                      <li key={example} className="figure">{example}</li>
                    ))}
                  </ul>
                )}
              </div>
            </article>
          </div>
        ))}
      </div>

      {history.loading && turns.length === 0 && <p className="thread-loading">Reading this case…</p>}

      <LiveStatus nodes={props.nodes} events={events} />
    </div>
  );
}
