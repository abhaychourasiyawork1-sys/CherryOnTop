import { useMemo, useState } from 'react';
import { subtreeOf } from '../lib/tasks.js';
import { caseStamp, useCaseEvents, useCaseReceipt } from '../lib/useCase.js';
import {
  decisionsOf, keyDecisions, evidenceOf, confidenceOf, CONFIDENCE_LABEL,
  type DecisionView, type Evidence,
} from '../lib/decisionView.js';
import { agentName } from '../lib/agentName.js';
import { useWorkspace } from '../shell/WorkspaceContext.js';
import type { OrgEvent } from '../lib/eventLog.js';

export interface DecisionData {
  decisions: DecisionView[];
  evidenceFor: (nodeId: string) => Evidence[];
  events: OrgEvent[];
  loading: boolean;
}

/** Everything the decision views read for one case, shared by the B-level
 *  surface and the Deep Dive so they can never disagree. */
export function useDecisionData(caseId: string): DecisionData {
  const ws = useWorkspace();
  const subtree = useMemo(() => subtreeOf(ws.org.nodes, caseId), [ws.org.nodes, caseId]);
  const scope = useMemo(() => new Set(subtree.map((node) => node.id)), [subtree]);
  const stamp = caseStamp(subtree);
  const receipt = useCaseReceipt(caseId, stamp);
  const { events, loading } = useCaseEvents(caseId, stamp, ws.org.events, scope);

  return useMemo(() => {
    const decisions = decisionsOf(receipt.data?.decisions ?? [], events);
    const evidence = evidenceOf({
      artifacts: receipt.data?.artifacts ?? [],
      events,
      approvals: receipt.data?.approvals,
      dod: receipt.data?.dod.items,
    });
    return {
      decisions,
      events,
      loading: loading || receipt.loading,
      evidenceFor: (nodeId: string) => evidence.filter((item) => item.nodeId === nodeId),
    };
  }, [receipt.data, receipt.loading, events, loading]);
}

/** Decisions, concise: what was decided, why, how much it rests on, and how
 *  sure that makes it. Everything more is in Deep Dive. */
export function DecisionSurface({ caseId }: { caseId: string }) {
  const data = useDecisionData(caseId);
  const [all, setAll] = useState(false);
  const key = keyDecisions(data.decisions);
  const shown = all || key.length === 0 ? data.decisions : key;

  if (data.loading && data.decisions.length === 0) return <p className="surface-empty">Reading decisions…</p>;
  if (data.decisions.length === 0) return <p className="surface-empty">No decisions are on record for this run yet.</p>;

  return (
    <div className="decisions">
      <ol className="decision-list">
        {shown.map((decision) => (
          <DecisionCard key={decision.id} caseId={caseId} decision={decision} evidence={data.evidenceFor(decision.nodeId)} />
        ))}
      </ol>
      {key.length > 0 && key.length < data.decisions.length && (
        <button type="button" className="quiet-link" onClick={() => setAll((v) => !v)}>
          {all ? 'Show only the key decisions' : `Show all ${data.decisions.length}, including routine ones`}
        </button>
      )}
    </div>
  );
}

function DecisionCard(props: { caseId: string; decision: DecisionView; evidence: Evidence[] }) {
  const ws = useWorkspace();
  const node = ws.org.nodes.find((n) => n.id === props.decision.nodeId);
  const confidence = confidenceOf(props.decision.engineConfidence, props.evidence);
  return (
    <li className="decision">
      <p className="decision-by">{node && node.parentId ? agentName(node.goal) : 'Organization'}</p>
      <h3 className="decision-title">{props.decision.title}</h3>
      {props.decision.why && (
        <>
          <p className="decision-label">Why</p>
          <p className="decision-why">{props.decision.why}</p>
        </>
      )}
      <dl className="decision-facts">
        <div><dt>Evidence</dt><dd className="figure">{props.evidence.length}</dd></div>
        <div><dt>Confidence</dt><dd data-confidence={confidence}>{CONFIDENCE_LABEL[confidence]}</dd></div>
      </dl>
      <button
        type="button"
        className="quiet-link"
        onClick={() => ws.surfaces.open('deep-dive', `decision:${props.caseId}:${props.decision.id}`, { deepDive: true })}
      >
        View decision
      </button>
    </li>
  );
}
