import { useMemo, useState } from 'react';
import { Markdown } from '../panels/Markdown.js';
import { resultOf, failureOf, revertGoal, filesChanged, type ResultModel } from '../lib/run.js';
import { useCaseEvents, type CaseSummary } from '../lib/useCase.js';
import { money } from '../lib/format.js';
import { daemon } from '../lib/client.js';
import { useWorkspace } from '../shell/WorkspaceContext.js';
import type { OrgNode } from '../lib/useOrg.js';

const STATUS_WORD: Record<ResultModel['status'], string> = {
  complete: 'Done',
  incomplete: 'Done, with checks not met',
  failed: 'Failed',
  stopped: 'Stopped',
};

/** What a finished run leaves behind, compact: its answer, what changed, and
 *  the links one level deeper — never a wall of agent output. */
export function ResultCard(props: { root: OrgNode; file: CaseSummary | null; stamp: string }) {
  const ws = useWorkspace();
  const [expanded, setExpanded] = useState(false);
  const result = resultOf(props.root, props.file?.artifacts ?? [], props.file?.dod.progress ?? null);
  const answer = props.file?.answer ?? null;
  const long = (answer?.length ?? 0) > 900;

  const meta: string[] = [];
  if (result.filesChanged.length > 0) meta.push(`${result.filesChanged.length} ${result.filesChanged.length === 1 ? 'file' : 'files'} changed`);
  if (result.checks) meta.push(`${result.checks.met} of ${result.checks.total} checks met`);
  meta.push(money(result.costUsd));

  return (
    <div className="result" data-status={result.status}>
      <p className="result-status">
        <span className="result-mark" aria-hidden="true">{result.status === 'complete' ? '✓' : result.status === 'incomplete' ? '◐' : '✕'}</span>
        {STATUS_WORD[result.status]}
      </p>
      {answer ? (
        <div className="result-answer" data-clamped={long && !expanded}>
          <Markdown source={answer} />
        </div>
      ) : (
        <p className="result-empty">{props.file ? 'It finished without writing a summary.' : 'Reading the result…'}</p>
      )}
      {long && (
        <button type="button" className="quiet-link" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : 'Show the whole answer'}
        </button>
      )}
      <p className="result-meta">{meta.join(' · ')}</p>
      <nav className="reply-actions" aria-label="Look deeper">
        <button type="button" className="quiet-link" onClick={() => ws.surfaces.open('decision', props.root.id)}>Decisions</button>
        <button type="button" className="quiet-link" onClick={() => { ws.focusCase(props.root.id); ws.openSection('evidence'); }}>Evidence</button>
        {result.filesChanged.length > 0 && (
          <button type="button" className="quiet-link" onClick={() => ws.surfaces.open('files', null)}>View changes</button>
        )}
        <button type="button" className="quiet-link" onClick={() => ws.surfaces.open('run', props.root.id)}>How it got there</button>
        {result.filesChanged.length > 0 && <RevertButton root={props.root} files={result.filesChanged} />}
      </nav>
    </div>
  );
}

/** Accountable revert: not an undo. It starts a new, recorded run that names
 *  the original, under the current mandate — so it can do no more than that
 *  mandate allows, and the original run stays exactly as it happened. Two
 *  steps, because it changes the project. */
function RevertButton({ root, files }: { root: OrgNode; files: string[] }) {
  const ws = useWorkspace();
  const [arming, setArming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (ws.blockedReason) return null;

  const revert = async () => {
    setBusy(true);
    setError(null);
    try {
      const id = await ws.startWork(revertGoal(root, files.map((file) => file.replace(/^\/workspace\//, ''))));
      ws.focusCase(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setArming(false);
    }
  };

  return (
    <span className="revert">
      {arming ? (
        <>
          <button type="button" className="quiet-link danger" disabled={busy} onClick={() => void revert()}>
            {busy ? 'Starting revert…' : `Revert ${files.length} ${files.length === 1 ? 'file' : 'files'} as a new run`}
          </button>
          <button type="button" className="quiet-link" onClick={() => setArming(false)}>Keep</button>
        </>
      ) : (
        <button type="button" className="quiet-link" onClick={() => setArming(true)}>Revert…</button>
      )}
      {error && <span className="inline-error">{error}</span>}
    </span>
  );
}

/** A failure as a state and a next step. Recovery is offered only where the
 *  runtime supports it, and every path leaves the failed attempt in history. */
export function FailureCard(props: { root: OrgNode; subtree: OrgNode[]; file: CaseSummary | null; stamp: string }) {
  const ws = useWorkspace();
  const scope = useMemo(() => new Set(props.subtree.map((node) => node.id)), [props.subtree]);
  const { events } = useCaseEvents(props.root.id, props.stamp, ws.org.events, scope);
  const failure = failureOf(props.root, events, props.file?.artifacts ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = filesChanged(props.file?.artifacts ?? []);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      ws.org.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const heading = props.root.state === 'INTERRUPTED' ? 'Paused' : props.root.state === 'CANCELLED' ? 'Stopped' : 'Did not finish';

  return (
    <div className="failure" data-state={props.root.state}>
      <p className="result-status"><span className="result-mark" aria-hidden="true">{props.root.state === 'INTERRUPTED' ? '❙❙' : '✕'}</span>{heading}</p>
      <dl className="failure-facts">
        <div><dt>What happened</dt><dd>{failure.whatHappened}</dd></div>
        <div><dt>What changed</dt><dd>{failure.whatIDid}</dd></div>
        <div>
          <dt>Next</dt>
          <dd>
            {failure.next === 'resume' ? 'Resume to carry on from where it stopped.'
              : failure.next === 'retry' ? 'Try again, or tell CherryOnTop what to do differently.'
                : 'Nothing is needed from you.'}
          </dd>
        </div>
      </dl>
      {error && <p className="inline-error">{error}</p>}
      <nav className="reply-actions" aria-label="Recover">
        {failure.next === 'resume' && (
          <button type="button" className="button" disabled={busy} onClick={() => void act(() => ws.resume(props.root.id))}>
            {busy ? 'Resuming…' : 'Resume'}
          </button>
        )}
        {failure.next === 'retry' && !ws.blockedReason && (
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => void act(async () => {
              const created = await daemon().node.replay.mutate({ nodeId: props.root.id, mandateId: ws.mandateId });
              ws.focusCase((created as { id: string }).id);
            })}
          >
            {busy ? 'Starting…' : 'Try again'}
          </button>
        )}
        <button type="button" className="quiet-link" onClick={() => ws.surfaces.open('run', props.root.id)}>How it got there</button>
        {changed.length > 0 && <RevertButton root={props.root} files={changed} />}
      </nav>
    </div>
  );
}
