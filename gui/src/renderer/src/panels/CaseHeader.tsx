import { useState } from 'react';
import { daemon } from '../lib/client.js';
import { Envelope } from './Envelope.js';
import { DodBadge } from './Cases.js';
import { money, duration, when } from '../lib/format.js';
import { toneOf, labelOf } from '../lib/state.js';
import type { Envelope as EnvelopeData, Mandate } from '../lib/mandates.js';
import type { DodItem } from './DodList.js';

export interface CaseFile {
  node: {
    id: string; goal: string; state: string; runtime?: string | null;
    repoPath?: string | null; createdAt: string; updatedAt: string;
    contract: { definition_of_done: string[] };
  };
  mandate: Mandate | null;
  envelope: EnvelopeData;
  summary: string;
  agents: number;
  costUsd: number;
  budgetUsd: number;
  budgetHealth: number;
  dod: { items: DodItem[]; progress: { met: number; unmet: number; unverified: number; total: number } };
  artifacts: { id: string }[];
  approvals: { id: string; status: string }[];
}

/**
 * Everything a person needs before any transcript.
 *
 * The ordering is the argument: what was asked for, what it was permitted to do,
 * where it got to, what it cost, what it proved, and what it needs from you.
 * A transcript answers none of those without being read end to end.
 */
/** Stopping a whole task, in two steps.
 *
 *  Two steps because it is not undoable and it can end a dozen agents at once —
 *  and one step because a modal for it would be heavier than the act deserves.
 *  The confirmation says how many agents will stop, since that is the number a
 *  person is actually weighing. */
function StopTask({ caseId, running, onStopped }: { caseId: string; running: number; onStopped: () => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      await daemon().node.cancelCase.mutate({ id: caseId });
      setAsking(false);
      onStopped();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!asking) {
    return (
      <button type="button" className="ghost-button stop-task" onClick={() => setAsking(true)}>
        Stop task
      </button>
    );
  }

  return (
    <span className="stop-confirm">
      <span className="stop-question">
        Stop {running === 1 ? 'the last agent' : `all ${running} agents`}?
      </span>
      <button type="button" className="stop-yes" disabled={busy} onClick={() => void stop()}>
        {busy ? 'Stopping' : 'Stop them'}
      </button>
      <button type="button" className="ghost-button" disabled={busy} onClick={() => setAsking(false)}>
        Keep running
      </button>
      {error && <span className="inbox-error">{error}</span>}
    </span>
  );
}

export function CaseHeader({ file, running = 0, onReplay, onStopped }: {
  file: CaseFile;
  /** Agents still going in this case. Zero hides the stop control entirely —
   *  offering to stop something that already finished is noise. */
  running?: number;
  onReplay?: () => void;
  onStopped?: () => void;
}) {
  const [showEnvelope, setShowEnvelope] = useState(false);
  const tone = toneOf(file.node.state);
  const pending = file.approvals.filter((a) => a.status === 'pending').length;
  const decisions = file.approvals.filter((a) => a.status === 'approved' || a.status === 'rejected').length;

  return (
    <header className="case-header" style={{ ['--state' as string]: `var(--${tone})` }}>
      <div className="case-header-top">
        <h1 className="case-header-goal">{file.node.goal}</h1>
        <div className="case-header-actions">
          {running > 0 && onStopped && (
            <StopTask caseId={file.node.id} running={running} onStopped={onStopped} />
          )}
          {onReplay && (
            <button type="button" className="ghost-button" onClick={onReplay}>
              Run again
            </button>
          )}
        </div>
      </div>

      <dl className="case-facts">
        <div>
          <dt>State</dt>
          <dd><span className="pill">{labelOf(file.node.state)}</span></dd>
        </div>
        <div>
          <dt>Organization</dt>
          <dd className="figure">{file.agents} agent{file.agents === 1 ? '' : 's'}</dd>
        </div>
        <div>
          <dt>Spend</dt>
          <dd className="figure" data-over={file.budgetHealth > 1}>
            {money(file.costUsd, 4)} <span className="ink-faint">of {money(file.budgetUsd)}</span>
          </dd>
        </div>
        <div>
          <dt>Checks</dt>
          <dd><DodBadge dod={file.dod.progress} /></dd>
        </div>
        <div>
          <dt>Produced</dt>
          <dd className="figure">{file.artifacts.length}</dd>
        </div>
        <div>
          <dt>Human decisions</dt>
          <dd className="figure">{decisions}{pending > 0 && <span className="ink-warn"> · {pending} waiting</span>}</dd>
        </div>
        <div>
          <dt>Ran for</dt>
          <dd className="figure">{duration(Date.parse(file.node.updatedAt) - Date.parse(file.node.createdAt))}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd className="figure">{when(file.node.createdAt)}</dd>
        </div>
      </dl>

      <div className="case-mandate">
        <button
          type="button"
          className="case-mandate-toggle"
          aria-expanded={showEnvelope}
          onClick={() => setShowEnvelope((current) => !current)}
        >
          <span className="mandate-mark" aria-hidden="true">⛨</span>
          <span className="case-mandate-name">{file.mandate?.name ?? 'Ad-hoc mandate'}</span>
          <span className="case-mandate-summary figure">{file.summary}</span>
          <span className="disclosure" aria-hidden="true">{showEnvelope ? '▾' : '▸'}</span>
        </button>
        {showEnvelope && (
          <>
            <Envelope envelope={file.envelope} />
            <p className="case-mandate-frozen">
              Recorded as it stood when this ran. Editing the mandate later does not change
              what this case was permitted to do.
            </p>
          </>
        )}
      </div>
    </header>
  );
}
