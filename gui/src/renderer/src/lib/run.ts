import { isTerminal } from './state.js';
import { clip } from './format.js';
import type { OrgNode } from './useOrg.js';
import type { OrgEvent } from './eventLog.js';

/** One run — a case — as the person who asked for it sees it: one coherent
 *  organization moving through a few phases, not a swarm of agents. Individual
 *  agents are one level deeper (Agents, the transcript). */

export type Phase = 'investigating' | 'working' | 'verifying' | 'waiting' | 'done' | 'failed' | 'stopped' | 'paused';

export const PHASES: { id: Phase; label: string }[] = [
  { id: 'investigating', label: 'Investigating' },
  { id: 'working', label: 'Working' },
  { id: 'verifying', label: 'Verifying' },
];

const INVESTIGATING = new Set(['CREATED', 'ORIENT', 'PLAN', 'INTELLIGENCE_GATE', 'EXECUTION_DECISION']);
const WORKING = new Set(['SELF_EXECUTE', 'DELEGATE']);
const WAITING = new Set(['WAIT_APPROVAL', 'ESCALATE']);

/** The phase of the organization as a whole. With several agents live, the one
 *  that most needs the reader wins: waiting on you beats working beats checking
 *  beats still-reading. */
export function phaseOf(root: OrgNode, subtree: OrgNode[]): Phase {
  if (root.state === 'COMPLETE') return 'done';
  if (root.state === 'CANCELLED') return 'stopped';
  if (root.state === 'FAILED') return 'failed';
  if (root.state === 'INTERRUPTED') return 'paused';
  const live = subtree.filter((node) => !isTerminal(node.state) && node.state !== 'INTERRUPTED');
  const states = new Set(live.map((node) => node.state));
  if ([...states].some((state) => WAITING.has(state))) return 'waiting';
  // A delegating parent is only "working" through its children; if none of
  // them is, it is waiting for its own verification or planning.
  if (live.some((node) => node.state === 'SELF_EXECUTE' || (node.state === 'DELEGATE' && node.childCount === 0))) return 'working';
  if (states.has('VERIFY') || states.has('VALIDATE')) return 'verifying';
  if ([...states].some((state) => INVESTIGATING.has(state))) return 'investigating';
  if ([...states].some((state) => WORKING.has(state))) return 'working';
  return 'investigating';
}

export function isLive(phase: Phase): boolean {
  return phase === 'investigating' || phase === 'working' || phase === 'verifying' || phase === 'waiting';
}

export interface ArtifactRow {
  id: string;
  nodeId: string;
  kind: string;
  path: string | null;
  summary: string;
  createdAt?: string;
}

export interface DodProgress { met: number; unmet: number; unverified: number; total: number }

export interface ResultModel {
  title: string;
  status: 'complete' | 'incomplete' | 'failed' | 'stopped';
  filesChanged: string[];
  checks: DodProgress | null;
  costUsd: number;
}

/** First sentence of what was asked, short enough to be a title. */
export function titleOf(goal: string): string {
  const firstLine = goal.split('\n').find((line) => line.trim())?.trim() ?? goal;
  const sentence = firstLine.match(/^(.{12,}?[.!?])(\s|$)/)?.[1] ?? firstLine;
  return clip(sentence.replace(/[.!?]$/, ''), 72);
}

export function filesChanged(artifacts: ArtifactRow[]): string[] {
  return [...new Set(artifacts
    .filter((artifact) => (artifact.kind === 'file_edit' || artifact.kind === 'file_write') && artifact.path)
    .map((artifact) => artifact.path!))];
}

export function resultOf(root: OrgNode, artifacts: ArtifactRow[], dod: DodProgress | null): ResultModel {
  const status: ResultModel['status'] =
    root.state === 'FAILED' ? 'failed'
      : root.state === 'CANCELLED' ? 'stopped'
        : dod && dod.unmet > 0 ? 'incomplete'
          : 'complete';
  return {
    title: titleOf(root.goal),
    status,
    filesChanged: filesChanged(artifacts),
    checks: dod && dod.total > 0 ? dod : null,
    costUsd: root.costUsd,
  };
}

export interface FailureModel {
  whatHappened: string;
  whatIDid: string;
  next: 'resume' | 'retry' | 'none';
}

/** A failure told as a state and a next step, never as a stack of red rows.
 *  "What I did" is computed from what the run actually changed, so it can
 *  never claim nothing was touched when something was. */
export function failureOf(root: OrgNode, events: OrgEvent[], artifacts: ArtifactRow[]): FailureModel {
  const lastProblem = [...events].reverse().find((event) =>
    event.type === 'step.outcome' && (event.payload as { succeeded?: boolean } | null)?.succeeded === false);
  const message = (lastProblem?.payload as { message?: string } | undefined)?.message;
  const changed = filesChanged(artifacts);
  return {
    whatHappened: root.state === 'INTERRUPTED'
      ? 'The daemon stopped while this was running.'
      : message ? clip(message, 220) : root.state === 'CANCELLED' ? 'It was stopped.' : 'It ended without finishing.',
    whatIDid: changed.length === 0
      ? 'No files were changed.'
      : `${changed.length} ${changed.length === 1 ? 'file was' : 'files were'} changed before it stopped. Nothing is undone automatically.`,
    next: root.state === 'INTERRUPTED' ? 'resume' : root.state === 'FAILED' || root.state === 'CANCELLED' ? 'retry' : 'none',
  };
}

/** The goal of an accountable revert: a new run, recorded like any other, that
 *  names the run it undoes and the files involved. It never rewrites history —
 *  the original run stays exactly as it was — and it runs under a mandate like
 *  anything else, so it cannot do more than that mandate allows. */
export function revertGoal(root: OrgNode, files: string[]): string {
  const list = files.length > 0 ? files.map((file) => `- ${file}`).join('\n') : '- (no files were recorded as changed)';
  return [
    `Revert the changes made by run ${root.id} ("${titleOf(root.goal)}").`,
    '',
    'Files that run changed:',
    list,
    '',
    'Restore each file to its state before that run. Do not change anything else. If a file has since been changed by other work, stop and report the conflict instead of overwriting it.',
  ].join('\n');
}
