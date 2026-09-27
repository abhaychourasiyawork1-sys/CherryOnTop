import { useMemo, useState } from 'react';
import { planOf, STEP_MARK, STEP_LABEL, type PlanStep } from '../lib/plan.js';
import { subtreeOf } from '../lib/tasks.js';
import { caseStamp, useCaseEvents, useCaseReceipt } from '../lib/useCase.js';
import { DodList } from '../panels/DodList.js';
import { daemon } from '../lib/client.js';
import { useWorkspace } from '../shell/WorkspaceContext.js';

/** The organization's plan for one run: the pieces of work, where each is,
 *  and every change to the plan with its reason. Natural language stays the
 *  main control (say what to change in the conversation); stopping a piece is
 *  the direct control the runtime supports, and it is recorded like any act. */
export function PlanSurface({ caseId }: { caseId: string }) {
  const ws = useWorkspace();
  const root = ws.org.nodes.find((node) => node.id === caseId) ?? null;
  const subtree = useMemo(() => (root ? subtreeOf(ws.org.nodes, root.id) : []), [ws.org.nodes, root]);
  const scope = useMemo(() => new Set(subtree.map((node) => node.id)), [subtree]);
  const stamp = caseStamp(subtree);
  const { events, loading } = useCaseEvents(caseId, stamp, ws.org.events, scope);
  const receipt = useCaseReceipt(caseId, stamp);

  if (!root) return <p className="surface-empty">This run is not in this Workspace any more.</p>;
  const plan = planOf(root, subtree, events);

  return (
    <div className="plan">
      {plan.source === 'none' ? (
        <p className="surface-empty">{loading ? 'Reading the plan…' : 'No plan yet. The organization plans once it has looked at the work.'}</p>
      ) : (
        <ol className="plan-steps">
          {plan.steps.map((step) => <Step key={step.id} step={step} />)}
        </ol>
      )}

      {plan.revisions.length > 0 && (
        <section className="plan-section" aria-labelledby="plan-changes">
          <h3 id="plan-changes" className="section-label">Plan changes</h3>
          <ul className="plan-revisions">
            {plan.revisions.map((revision) => (
              <li key={revision.id}>
                <p className="revision-what">
                  {revision.change === 'removed' ? 'Removed' : revision.change === 'replaced' ? 'Replaced' : 'Changed'}: {revision.what}
                </p>
                <p className="revision-why">{revision.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="plan-section" aria-labelledby="plan-checks">
        <h3 id="plan-checks" className="section-label">What counts as done</h3>
        {receipt.data
          ? <DodList items={receipt.data.dod.items.filter((item) => item.nodeId === root.id)} editable onChanged={() => { receipt.reload(); ws.org.refresh(); }} />
          : <p className="surface-empty">Reading…</p>}
      </section>

      <p className="plan-hint">To change the plan, say what you want in the conversation.</p>
    </div>
  );
}

function Step({ step }: { step: PlanStep }) {
  const ws = useWorkspace();
  const [arming, setArming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stoppable = step.nodeId && (step.status === 'active' || step.status === 'pending');

  const stop = async () => {
    try {
      await daemon().node.cancel.mutate({ nodeId: step.nodeId! });
      ws.org.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setArming(false);
    }
  };

  return (
    <li className="plan-step" data-status={step.status}>
      <span className="step-mark" aria-hidden="true">{STEP_MARK[step.status]}</span>
      <div className="step-body">
        {step.nodeId ? (
          <button type="button" className="step-title linkish" onClick={() => ws.openSection('agents', step.nodeId)}>{step.title}</button>
        ) : (
          <span className="step-title">{step.title}</span>
        )}
        <span className="step-status">
          {STEP_LABEL[step.status]}{step.depth > 0 ? `, ${step.depth} sub-step${step.depth === 1 ? '' : 's'}` : ''}
        </span>
        {error && <span className="inline-error">{error}</span>}
      </div>
      {stoppable && (
        arming ? (
          <span className="step-actions">
            <button type="button" className="quiet-link danger" onClick={() => void stop()}>Stop this piece</button>
            <button type="button" className="quiet-link" onClick={() => setArming(false)}>Keep</button>
          </span>
        ) : (
          <button type="button" className="icon-button step-more" aria-label={`Stop “${step.title}”`} title="Stop this piece" onClick={() => setArming(true)}>–</button>
        )
      )}
    </li>
  );
}
