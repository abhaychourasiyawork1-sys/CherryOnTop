import { useEffect, useState } from 'react';
import { PHASES, type Phase } from '../lib/run.js';
import { lastProgress } from '../panels/LiveStatus.js';
import { duration } from '../lib/format.js';
import { isTerminal } from '../lib/state.js';
import { StopTask } from '../panels/CaseHeader.js';
import type { OrgNode } from '../lib/useOrg.js';
import type { OrgEvent } from '../lib/eventLog.js';
import { DelegationStrip } from './DelegationStrip.js';
import { RunSteps } from './ResultSurface.js';
import { caseStamp } from '../lib/useCase.js';

const HEADLINE: Partial<Record<Phase, string>> = {
  investigating: 'CherryOnTop is looking into it',
  working: 'CherryOnTop is working',
  verifying: 'CherryOnTop is checking its work',
  waiting: 'Waiting for you',
};

/** A live run, compact: one organization, three phases, one line of what it
 *  is doing now. Several agents working at once are still one sentence here;
 *  who is doing what is one click deeper. The moving light on the current
 *  phase is the one continuous animation in the product — it exists only
 *  while something is genuinely live. */
export function RunLine(props: {
  root: OrgNode;
  subtree: OrgNode[];
  phase: Phase;
  events: OrgEvent[];
  onWatch: () => void;
  onPlan: () => void;
  onStopped: () => void;
}) {
  const { phase } = props;
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const live = props.subtree.filter((node) => !isTerminal(node.state) && node.state !== 'INTERRUPTED');
  // What the most recently active agent said it is doing.
  const latest = [...live].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const now = latest.map((node) => lastProgress(props.events, node.id)).find(Boolean)
    ?? (phase === 'investigating' ? 'Choosing an approach and the right model for it' : '');
  const current = PHASES.findIndex((p) => p.id === phase);
  const elapsed = duration(Date.now() - Date.parse(props.root.createdAt));

  return (
    <div className="runline" data-phase={phase} aria-live="polite">
      <p className="runline-head">
        <span className="runline-title">{HEADLINE[phase] ?? 'Working'}</span>
        <span className="runline-elapsed figure">{elapsed}</span>
      </p>
      {phase !== 'waiting' && (
        <ol className="phases" aria-label="Progress">
          {PHASES.map((step, index) => (
            <li
              key={step.id}
              data-state={index < current ? 'done' : index === current ? 'current' : 'next'}
              aria-current={index === current ? 'step' : undefined}
            >
              <span className="phase-label">{step.label}</span>
            </li>
          ))}
        </ol>
      )}
      {now && <p className="runline-now">{now}</p>}
      <DelegationStrip root={props.root} />
      <div className="reply-actions">
        <button type="button" className="quiet-link" onClick={props.onWatch}>Watch the work</button>
        <button type="button" className="quiet-link" onClick={props.onPlan}>Plan</button>
        {live.length > 1 && <span className="reply-aside">{live.length} agents on it</span>}
        <span className="reply-end"><StopTask caseId={props.root.id} running={Math.max(1, live.length)} onStopped={props.onStopped} /></span>
      </div>
      <RunSteps root={props.root} stamp={caseStamp(props.subtree)} />
    </div>
  );
}
