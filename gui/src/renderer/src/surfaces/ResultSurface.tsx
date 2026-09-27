import { useMemo, useState } from 'react';
import { Markdown } from '../panels/Markdown.js';
import { resultOf, failureOf, revertGoal, filesChanged, type ResultModel } from '../lib/run.js';
import { useCaseEvents, type CaseSummary } from '../lib/useCase.js';
import { explainRun, stepsOf, type Verdict } from '../lib/explain.js';
import { DelegationStrip } from './DelegationStrip.js';
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
  const result = resultOf(props.root, props.file?.artifacts ?? [], props.file?.dod.progress ?? null);
  const answer = props.file?.answer ?? null;

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
      <DelegationStrip root={props.root} />
      <Response answer={answer} loaded={props.file !== null} />
      <p className="result-meta">{meta.join(' · ')}</p>
      <nav className="reply-actions" aria-label="Look deeper">
        <button type="button" className="quiet-link" onClick={() => ws.surfaces.open('decision', props.root.id)}>Decisions</button>
        <button type="button" className="quiet-link" onClick={() => { ws.focusCase(props.root.id); ws.openSection('evidence'); }}>Evidence</button>
        {result.filesChanged.length > 0 && (
          <button type="button" className="quiet-link" onClick={() => ws.surfaces.open('files', null)}>View changes</button>
        )}
        <button type="button" className="quiet-link" onClick={() => ws.surfaces.open('run', props.root.id)}>Watch the work</button>
        {result.filesChanged.length > 0 && <RevertButton root={props.root} files={result.filesChanged} />}
      </nav>
      <RunSteps root={props.root} stamp={props.stamp} />
    </div>
  );
}

/** What the root agent answered, printed as the reply — for a run that failed
 *  as much as for one that worked, since what it found is often the point. */
function Response({ answer, loaded, label = 'Response' }: { answer: string | null; loaded: boolean; label?: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = (answer?.length ?? 0) > 1400;
  if (!answer) {
    return <p className="result-empty">{loaded ? 'The agent did not write a final response.' : 'Reading the response…'}</p>;
  }
  return (
    <section className="response" aria-label={label}>
      <h3 className="response-label">{label}</h3>
      <div className="result-answer" data-clamped={long && !expanded}>
        <Markdown source={answer} />
      </div>
      {long && (
        <button type="button" className="quiet-link" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : 'Show the whole response'}
        </button>
      )}
    </section>
  );
}

/** The run as a short list of what happened — each decision and why, each
 *  agent, each check — one click away and closed by default, so the reply
 *  stays clean and nothing is hidden. */
export function RunSteps({ root, stamp }: { root: OrgNode; stamp: string }) {
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  const subtree = useMemo(() => ws.org.nodes.filter((n) => n.id === root.id || isUnder(ws.org.nodes, n, root.id)), [ws.org.nodes, root.id]);
  const scope = useMemo(() => new Set(subtree.map((n) => n.id)), [subtree]);
  const { events, loading } = useCaseEvents(open ? root.id : null, stamp, ws.org.events, scope);
  const steps = useMemo(() => (open ? stepsOf(root, subtree, events) : []), [open, root, subtree, events]);
  return (
    <div className="run-steps" data-open={open}>
      <button type="button" className="run-steps-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="run-steps-chevron" aria-hidden="true">›</span>
        {open && steps.length > 0 ? `How it went · ${steps.length} steps` : 'How it went'}
      </button>
      {open && (
        loading && steps.length === 0 ? <p className="result-empty">Reading the record…</p> : (
          <ol className="steps">
            {steps.map((step) => (
              <li key={step.id} className="step" data-tone={step.tone}>
                <span className="step-dot" aria-hidden="true" />
                <span className="step-body">
                  <span className="step-text">
                    {step.agent && <span className="step-agent">{step.agent}</span>}
                    {step.text}
                  </span>
                  {step.detail && <span className="step-detail">{step.detail}</span>}
                </span>
                <time className="step-time figure" dateTime={step.at}>{step.offset}</time>
              </li>
            ))}
          </ol>
        )
      )}
    </div>
  );
}

function isUnder(nodes: OrgNode[], node: OrgNode, rootId: string): boolean {
  let parent = node.parentId;
  for (let guard = 0; parent && guard < 50; guard++) {
    if (parent === rootId) return true;
    parent = nodes.find((n) => n.id === parent)?.parentId ?? null;
  }
  return false;
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

const HEADING: Record<Exclude<Verdict, 'done'>, string> = {
  unverified: 'Finished, but not confirmed',
  failed: 'Did not finish',
  stopped: 'Stopped',
  paused: 'Paused',
};

/** A failure told plainly: why it failed, what it did anyway, what it said,
 *  and what you can do next. Recovery is offered only where the runtime
 *  supports it, and every path leaves the failed attempt in history. */
export function FailureCard(props: { root: OrgNode; subtree: OrgNode[]; file: CaseSummary | null; stamp: string }) {
  const ws = useWorkspace();
  const scope = useMemo(() => new Set(props.subtree.map((node) => node.id)), [props.subtree]);
  const { events } = useCaseEvents(props.root.id, props.stamp, ws.org.events, scope, 300);
  const artifacts = props.file?.artifacts ?? [];
  const failure = failureOf(props.root, events, artifacts);
  const explained = explainRun(props.root, props.subtree, events, artifacts);
  const verdict = explained.verdict === 'done' ? 'failed' : explained.verdict;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = filesChanged(artifacts);

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

  return (
    <div className="failure" data-state={props.root.state} data-verdict={verdict}>
      <p className="result-status">
        <span className="result-mark" aria-hidden="true">{verdict === 'paused' ? '❙❙' : verdict === 'unverified' ? '◐' : '✕'}</span>
        {HEADING[verdict]}
      </p>
      <DelegationStrip root={props.root} />
      <section className="explain" aria-label="Why">
        <h3 className="response-label">Why</h3>
        <ul className="explain-list">{explained.why.map((line) => <li key={line}>{line}</li>)}</ul>
      </section>
      <section className="explain" aria-label="What it did">
        <h3 className="response-label">What it did</h3>
        <ul className="explain-list" data-kind="did">{explained.did.map((line) => <li key={line}><Markdown source={line} /></li>)}</ul>
      </section>
      <Response answer={props.file?.answer ?? null} loaded={props.file !== null} />
      <p className="failure-next">
        {failure.next === 'resume' ? 'Resume to carry on from where it stopped.'
          : verdict === 'unverified' ? 'If the result is right, nothing is needed. To have it confirmed, ask for a check, such as “run the tests”.'
            : failure.next === 'retry' ? 'Try again, or tell CherryOnTop what to do differently.'
              : 'Nothing is needed from you.'}
      </p>
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
        <button type="button" className="quiet-link" onClick={() => ws.surfaces.open('run', props.root.id)}>Watch the work</button>
        {changed.length > 0 && <RevertButton root={props.root} files={changed} />}
      </nav>
      <RunSteps root={props.root} stamp={props.stamp} />
    </div>
  );
}
