/** What crosses the parent↔child boundary, and how little of it there is.
 *
 *  A child's report and a parent's feedback are both *facts plus references*.
 *  Neither is a transcript: a rework handoff that replayed the conversation
 *  would cost the same as starting over, which is the cost same-child rework
 *  exists to avoid. So every field here is clipped and every list is capped, and
 *  the caps are what make "bounded" a property of the builder rather than of
 *  whatever a model happened to write.
 *
 *  Pure and total — nothing here reads the database or throws on bad input. */
import { parseResultEnvelope, type AgentResultStatus } from '../intelligence/result-envelope.js';
import {
  ChildReportSchema, ParentFeedbackSchema,
  type ChildReport, type ParentFeedback,
} from '../schemas/delegation.js';

export type ChildDelegationReport = ChildReport;
export type { ParentFeedback };

/** Items kept per list, and characters kept per item. Deliberately small: the
 *  point of a reference is that the reader can go and get the rest. */
export const MAX_REPORT_ITEMS = 20;
const MAX_ITEM_CHARS = 500;
const MAX_SUMMARY_CHARS = 1_000;
const MAX_OBSERVED_CHARS = 600;

/** The whole rework handoff. An order of magnitude under `MAX_REPORT_CHARS`
 *  (`intelligence/synthesize.ts`), which is what a raw child report may be. */
export const MAX_REWORK_CONTEXT_CHARS = 3_500;

function clip(text: string, max: number): string {
  const trimmed = (text ?? '').trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

function clipped(items: readonly string[] | undefined, max = MAX_ITEM_CHARS): string[] {
  return (items ?? []).map((item) => clip(String(item), max)).filter(Boolean).slice(0, MAX_REPORT_ITEMS);
}

export interface BuildReportInput {
  assignmentId: string;
  /** The child's final answer, prose with an optional result envelope. */
  answer: string;
  /** What the child's own validation concluded. Not what it claims. */
  succeeded: boolean;
  /** Paths the runtime *observed* the child write. Preferred over the child's
   *  own list, which is a claim. */
  changedFiles?: string[];
  observedChecks?: Array<{ id: string; command: string; passed: boolean }>;
  evidenceRefs?: string[];
}

/** The child's report, from what the existing result envelope already carries.
 *
 *  No second child-result format: the envelope a child already closes with
 *  supplies the summary, findings and uncertainties, and the runtime supplies
 *  what it observed (files written, commands run). A child that ignored the
 *  envelope request degrades to the first line of its prose, exactly as
 *  `parseResultEnvelope` already does. */
export function buildChildDelegationReport(input: BuildReportInput): ChildReport {
  const fallback: AgentResultStatus = input.succeeded ? 'success' : 'failed';
  const { envelope } = parseResultEnvelope(input.answer, fallback);
  const selfBlocked = envelope.status === 'blocked' || envelope.status === 'needs_input' || envelope.status === 'failed';
  const summary = clip(envelope.summary, MAX_SUMMARY_CHARS);

  const changed = [...new Set([...(input.changedFiles ?? []), ...envelope.changedFiles])].sort();

  const report: ChildReport = {
    assignmentId: input.assignmentId,
    status: selfBlocked ? 'blocked' : 'ready',
    summary,
    completedWork: clipped(envelope.findings),
    changedFiles: clipped(changed),
    evidenceRefs: clipped(input.evidenceRefs, 200),
    testsRun: (input.observedChecks ?? []).slice(0, MAX_REPORT_ITEMS).map((check) => ({
      command: clip(check.command, MAX_ITEM_CHARS), passed: check.passed, evidenceId: check.id,
    })),
    assumptions: [],
    uncertainties: clipped(envelope.uncertainties),
    blockers: selfBlocked && summary ? [summary] : [],
    remainingWork: envelope.status === 'partial' && summary ? [clip(`Unfinished: ${summary}`, MAX_ITEM_CHARS)] : [],
  };
  // The builder's own output must satisfy the contract it is stored under.
  return ChildReportSchema.parse(report);
}

export interface FailedCheck {
  check: string;
  observed: string;
  expected: string;
  evidenceRefs: string[];
}

export interface BuildFeedbackInput {
  assignmentId: string;
  revision: number;
  failedChecks: FailedCheck[];
  guidance?: string[];
}

/** The parent's verdict, addressed to the same child. Only the failures — a check
 *  that passed is not the child's problem, and repeating it is tokens. */
export function buildParentFeedback(input: BuildFeedbackInput): ParentFeedback {
  const failedChecks = input.failedChecks.slice(0, MAX_REPORT_ITEMS).map((failed) => ({
    check: clip(failed.check, MAX_ITEM_CHARS),
    observed: clip(failed.observed, MAX_OBSERVED_CHARS),
    expected: clip(failed.expected, MAX_OBSERVED_CHARS),
    evidenceRefs: clipped(failed.evidenceRefs, 200),
  }));
  return ParentFeedbackSchema.parse({
    assignmentId: input.assignmentId,
    revision: input.revision,
    failedChecks,
    requiredChanges: failedChecks.map((failed) => `Make this hold: ${failed.check} (expected ${failed.expected}; observed ${failed.observed})`)
      .map((line) => clip(line, MAX_ITEM_CHARS)),
    guidance: clipped(input.guidance),
    nextChecks: failedChecks.map((failed) => failed.check),
  });
}

export interface ReworkContextInput {
  goal: string;
  definitionOfDone: string[];
  acceptanceChecks: string[];
  feedback: ParentFeedback;
  previousReport?: ChildReport;
  /** Earlier feedback, oldest first. Used only to say which checks keep failing. */
  feedbackHistory: ParentFeedback[];
}

/** The handoff for the *same* child's next revision.
 *
 *  It is a checklist and a set of pointers: the contract, what the parent found
 *  wrong, what the child said it did and where the evidence is. The child's
 *  worktree already holds its own changes, so paths are enough — the child can
 *  look; it does not need to be re-told.
 *
 *  Hard-capped: sections are written in priority order (the feedback first) and
 *  the whole is cut at `MAX_REWORK_CONTEXT_CHARS`, so no input, however large,
 *  can turn a rework into a transcript replay. */
export function compactReworkContext(input: ReworkContextInput): string {
  const { feedback } = input;
  const earlier = new Set(input.feedbackHistory.flatMap((old) => old.failedChecks.map((failed) => failed.check)));
  const repeated = feedback.failedChecks.filter((failed) => earlier.has(failed.check)).map((failed) => failed.check);

  const lines: string[] = [
    `## Rework: revision ${feedback.revision} — your work was reviewed and not accepted yet`,
    'You keep the same workspace and everything you already changed. Fix only what failed; do not start over.',
    '',
    '### What the parent found',
  ];
  for (const failed of feedback.failedChecks) {
    lines.push(`- FAILED: ${clip(failed.check, 300)} — expected ${clip(failed.expected, 300)}; observed ${clip(failed.observed, 400)}${failed.evidenceRefs.length ? ` [evidence: ${failed.evidenceRefs.slice(0, 5).join(', ')}]` : ''}`);
  }
  if (repeated.length > 0) {
    lines.push(`- These checks failed before, too — a different approach is needed: ${repeated.slice(0, 5).map((c) => clip(c, 200)).join('; ')}`);
  }
  if (feedback.requiredChanges.length > 0) {
    lines.push('', '### Required changes');
    for (const change of feedback.requiredChanges.slice(0, 8)) lines.push(`- ${clip(change, 400)}`);
  }
  if (feedback.guidance.length > 0) {
    lines.push('', '### Guidance');
    for (const item of feedback.guidance.slice(0, 5)) lines.push(`- ${clip(item, 300)}`);
  }
  lines.push('', '### Contract (unchanged)', `Goal: ${clip(input.goal, 500)}`);
  if (input.definitionOfDone.length > 0) {
    lines.push('Definition of done:', ...input.definitionOfDone.slice(0, 8).map((item) => `- ${clip(item, 200)}`));
  }
  if (input.acceptanceChecks.length > 0) {
    lines.push('The parent will accept only when:', ...input.acceptanceChecks.slice(0, 8).map((item) => `- ${clip(item, 200)}`));
  }
  const previous = input.previousReport;
  if (previous) {
    lines.push('', '### Your previous report', clip(previous.summary, 500) || '(no summary)');
    if (previous.changedFiles.length > 0) lines.push(`Changed: ${previous.changedFiles.slice(0, 15).join(', ')}`);
    if (previous.evidenceRefs.length > 0) lines.push(`Evidence: ${previous.evidenceRefs.slice(0, 10).join(', ')}`);
    const failedRuns = previous.testsRun.filter((run) => !run.passed).slice(0, 5);
    if (failedRuns.length > 0) lines.push(`Failed runs: ${failedRuns.map((run) => clip(run.command, 120)).join('; ')}`);
  }
  if (feedback.nextChecks.length > 0) {
    lines.push('', `Before reporting again, make these pass: ${feedback.nextChecks.slice(0, 8).map((c) => clip(c, 200)).join('; ')}`);
  }

  const text = lines.join('\n');
  return text.length <= MAX_REWORK_CONTEXT_CHARS
    ? text
    : `${text.slice(0, MAX_REWORK_CONTEXT_CHARS - 20)}\n[…clipped]`;
}

/** The goal a reworking child is dispatched with: its own goal, unchanged and
 *  on top, then the handoff. The node row keeps the original goal, so what a
 *  person reads in the tree does not turn into machine instructions. */
export function reworkGoal(originalGoal: string, context: string): string {
  return `${originalGoal}\n\n${context}`;
}
