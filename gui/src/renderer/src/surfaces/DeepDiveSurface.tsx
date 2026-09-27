import { useMemo } from 'react';
import { useDecisionData } from './DecisionSurface.js';
import { WhyPanel } from '../panels/WhyPanel.js';
import { Receipt } from '../panels/Receipt.js';
import { daemon } from '../lib/client.js';
import { useDaemonQuery } from '../lib/useDaemonQuery.js';
import {
  confidenceOf, countByType, evidenceOf, CONFIDENCE_LABEL, EVIDENCE_LABEL,
  type Evidence, type EvidenceType,
} from '../lib/decisionView.js';
import { subtreeOf } from '../lib/tasks.js';
import { caseStamp, useCaseEvents, useCaseReceipt } from '../lib/useCase.js';
import { agentName } from '../lib/agentName.js';
import { when, money } from '../lib/format.js';
import { displayPath } from '../lib/artifacts.js';
import { useWorkspace } from '../shell/WorkspaceContext.js';
import type { OrgEvent } from '../lib/eventLog.js';

/** Parses a Deep Dive target: `decision:<caseId>:<decisionId>` or
 *  `evidence:<caseId>`. Decision ids may themselves contain colons. */
export function parseTarget(target: string): { kind: 'decision' | 'evidence'; caseId: string; id: string | null } | null {
  const [kind, caseId, ...rest] = target.split(':');
  if ((kind !== 'decision' && kind !== 'evidence') || !caseId) return null;
  return { kind, caseId, id: rest.length > 0 ? rest.join(':') : null };
}

export function DeepDive({ target }: { target: string }) {
  const parsed = parseTarget(target);
  if (!parsed) return <p className="surface-empty">This view is no longer available.</p>;
  if (parsed.kind === 'evidence') return <EvidenceDeepDive caseId={parsed.caseId} />;
  return <DecisionDeepDive caseId={parsed.caseId} decisionId={parsed.id ?? ''} />;
}

/** C-level: a decision in full. Structured record only — what was chosen,
 *  the runtime's stated reason, what it beat, what it rests on and what came
 *  of it. There is no section for model thinking because none is shown. */
function DecisionDeepDive({ caseId, decisionId }: { caseId: string; decisionId: string }) {
  const ws = useWorkspace();
  const data = useDecisionData(caseId);
  const decision = data.decisions.find((d) => d.id === decisionId);
  if (!decision) return <p className="surface-empty">{data.loading ? 'Reading the decision…' : 'This decision is not on record.'}</p>;

  const node = ws.org.nodes.find((n) => n.id === decision.nodeId);
  const evidence = data.evidenceFor(decision.nodeId);
  const confidence = confidenceOf(decision.engineConfidence, evidence);
  const after = evidence.filter((item) => item.at >= decision.at && item.provenance.kind === 'artifact');

  return (
    <article className="deep">
      <header className="deep-head">
        <p className="deep-kicker">Decision by {node && node.parentId ? agentName(node.goal) : 'the organization'} · {when(decision.at)}</p>
        <h1 className="deep-title">{decision.title}</h1>
      </header>

      <DeepSection title="Summary">
        <p>{decision.title}. Confidence: <strong data-confidence={confidence}>{CONFIDENCE_LABEL[confidence]}</strong>{decision.engineConfidence !== null && ` (the engine reported ${Math.round(decision.engineConfidence * 100)}%, limited by the evidence on record)`}.</p>
        {decision.gate && <p className="deep-note">Decided by a rule, “{decision.gate}”, rather than by comparing options.</p>}
      </DeepSection>

      <DeepSection title="Reasoning summary">
        <p>{decision.why || 'No reason was recorded for this decision.'}</p>
        <p className="deep-note">This is the reason the runtime recorded with the decision. Model thinking is never shown.</p>
      </DeepSection>

      <DeepSection title="Alternatives">
        {decision.alternatives.length === 0
          ? <p className="deep-note">No alternatives were compared{decision.gate ? ' — a rule decided it' : ''}.</p>
          : (
            <ul className="deep-list">
              {decision.alternatives.map((alt) => <li key={alt.label}><strong>{alt.label}</strong> — {alt.reason}</li>)}
            </ul>
          )}
      </DeepSection>

      <DeepSection title={`Evidence · ${evidence.length}`}>
        <EvidenceList evidence={evidence} />
      </DeepSection>

      <DeepSection title="Actions that followed">
        {after.length === 0 ? <p className="deep-note">Nothing was recorded after this decision.</p> : (
          <ul className="deep-list">
            {after.slice(0, 12).map((item) => <li key={item.id}>{item.summary}</li>)}
            {after.length > 12 && <li className="deep-note">and {after.length - 12} more</li>}
          </ul>
        )}
      </DeepSection>

      <ExecutionStrategy caseId={caseId} nodeId={decision.nodeId} events={data.events} />

      {decision.row && (
        <DeepSection title="Decision record">
          <WhyPanel decision={decision.row} />
        </DeepSection>
      )}

      <DeepSection title="Receipt">
        <button type="button" className="quiet-link" onClick={() => ws.surfaces.open('deep-dive', `evidence:${caseId}`, { deepDive: true })}>
          Open the whole run’s receipt
        </button>
      </DeepSection>
    </article>
  );
}

/** Which models and structured-decision capabilities the node used, from the
 *  record: the model on each dispatch, the router's stated reason, and the
 *  System-1 judgments with their question versions. The engine behind a
 *  capability is an implementation detail, shown last and small. */
function ExecutionStrategy({ caseId, nodeId, events }: { caseId: string; nodeId: string; events: OrgEvent[] }) {
  const routes = useDaemonQuery(
    () => daemon().memory.recent.query({ kind: 'model_route', limit: 500 }) as Promise<{ nodeId: string | null; key: string; value: { tier?: string; reason?: string } }[]>,
    [caseId],
  );
  const capabilities = useDaemonQuery(
    // An older daemon has no capability discovery; the section then simply
    // does not annotate. Nothing here depends on which engine answers.
    () => daemon().daemon.capabilities.query().catch(() => null),
    [],
  );

  const models = useMemo(() => {
    const seen = new Map<string, number>();
    for (const event of events) {
      if (event.nodeId !== nodeId || event.type !== 'exec.assistant') continue;
      const model = (event.payload as { message?: { model?: string } } | null)?.message?.model;
      if (model) seen.set(model, (seen.get(model) ?? 0) + 1);
    }
    return [...seen.entries()];
  }, [events, nodeId]);
  const judgments = events.filter((event) => event.nodeId === nodeId && event.type === 'system1.judgment')
    .map((event) => event.payload as { surface?: string; questionVersion?: string; provider?: string; calibratedOutput?: { probabilities?: Record<string, number>; calibratedProbability?: number } });
  const nodeRoutes = (routes.data ?? []).filter((route) => route.nodeId === nodeId);
  const known = new Set<string>((capabilities.data?.capabilities ?? []).map((c) => c.id));

  if (models.length === 0 && judgments.length === 0 && nodeRoutes.length === 0) return null;

  return (
    <DeepSection title="Execution strategy">
      <dl className="deep-facts">
        {nodeRoutes.slice(0, 3).map((route, index) => (
          <div key={index}><dt>{route.key === 'execute' ? 'Work' : route.key}</dt><dd>{route.value.tier ?? 'default'} tier — {route.value.reason ?? 'no reason recorded'}</dd></div>
        ))}
        {models.map(([model, calls]) => (
          <div key={model}><dt>Model</dt><dd><span className="figure">{model}</span> <span className="deep-note">({calls} {calls === 1 ? 'turn' : 'turns'})</span></dd></div>
        ))}
      </dl>
      {judgments.length > 0 && (
        <>
          <p className="decision-label">Structured decision evaluation</p>
          <ul className="deep-list">
            {judgments.map((j, index) => (
              <li key={index}>
                <span className="figure">{j.questionVersion ?? j.surface}</span>
                {j.calibratedOutput?.calibratedProbability != null && <> — {Math.round(j.calibratedOutput.calibratedProbability * 100)}% calibrated</>}
                {j.surface && capabilities.data && !known.has(j.surface) && <span className="deep-note"> (capability no longer offered)</span>}
                {j.provider && <span className="deep-note"> · evaluated by {j.provider}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </DeepSection>
  );
}

function DeepSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="deep-section">
      <h2 className="deep-section-title">{title}</h2>
      {children}
    </section>
  );
}

const ORDER: EvidenceType[] = ['verified', 'user', 'observed', 'derived', 'external'];

export function EvidenceList({ evidence, limit = 40 }: { evidence: Evidence[]; limit?: number }) {
  if (evidence.length === 0) return <p className="deep-note">No evidence is on record. Confidence is limited accordingly.</p>;
  const sorted = [...evidence].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type) || b.at.localeCompare(a.at));
  return (
    <ul className="evidence-list">
      {sorted.slice(0, limit).map((item) => (
        <li key={item.id} data-type={item.type}>
          <span className="evidence-type">{EVIDENCE_LABEL[item.type]}</span>
          <span className="evidence-summary">{displayPath(item.summary.replace(/^(Edited|Wrote) \/workspace\//, '$1 '))}</span>
          <span className="evidence-source figure" title={`${item.provenance.kind} ${item.provenance.ref}`}>{item.provenance.kind} {item.provenance.ref.slice(0, 8)}</span>
        </li>
      ))}
      {sorted.length > limit && <li className="deep-note">and {sorted.length - limit} more in the receipt</li>}
    </ul>
  );
}

/** Evidence for a whole run: typed counts, the strongest items first, then the
 *  full receipt — the existing shareable record, unchanged. */
function EvidenceDeepDive({ caseId }: { caseId: string }) {
  const ws = useWorkspace();
  const subtree = useMemo(() => subtreeOf(ws.org.nodes, caseId), [ws.org.nodes, caseId]);
  const scope = useMemo(() => new Set(subtree.map((n) => n.id)), [subtree]);
  const stamp = caseStamp(subtree);
  const receipt = useCaseReceipt(caseId, stamp);
  const { events } = useCaseEvents(caseId, stamp, ws.org.events, scope);
  const evidence = useMemo(() => evidenceOf({
    artifacts: receipt.data?.artifacts ?? [], events, approvals: receipt.data?.approvals, dod: receipt.data?.dod.items,
  }), [receipt.data, events]);
  const counts = countByType(evidence);
  const root = ws.org.nodes.find((n) => n.id === caseId);

  return (
    <article className="deep">
      <header className="deep-head">
        <p className="deep-kicker">Evidence{root ? ` · ${money(root.costUsd)} spent` : ''}</p>
        <h1 className="deep-title">What this run rests on</h1>
      </header>
      <DeepSection title="By kind">
        <dl className="evidence-counts">
          {ORDER.map((type) => (
            <div key={type} data-type={type}><dt>{EVIDENCE_LABEL[type]}</dt><dd className="figure">{counts[type]}</dd></div>
          ))}
        </dl>
      </DeepSection>
      <DeepSection title="Strongest first">
        <EvidenceList evidence={evidence} limit={30} />
      </DeepSection>
      <DeepSection title="Receipt">
        <Receipt caseId={caseId} onOpenNode={(nodeId) => ws.openSection('agents', nodeId)} revision={ws.org.revision} />
      </DeepSection>
    </article>
  );
}
