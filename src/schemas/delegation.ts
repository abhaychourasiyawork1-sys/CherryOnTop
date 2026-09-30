import { z } from 'zod';
import { AuthoritySchema } from './node-contract.js';

/** Where one parent→child assignment stands.
 *
 *  This is a *relationship* projection, not a second node lifecycle. A node's
 *  own state machine (`node-machine.ts`) still says whether the child process is
 *  running, validating or finished; this says whose turn it is on the contract
 *  between the two of them — the child's (to work), or the parent's (to review).
 *
 *  Happy path:   ASSIGNED → WORKING → REPORT_READY → UNDER_REVIEW → ACCEPTED → MERGING → MERGED
 *  Failure loop: REPORT_READY → UNDER_REVIEW → FEEDBACK_REQUIRED → REWORKING → REPORT_READY
 */
export const DELEGATION_STATUSES = [
  'ASSIGNED', 'WORKING', 'REPORT_READY', 'UNDER_REVIEW', 'ACCEPTED', 'MERGING', 'MERGED',
  'FEEDBACK_REQUIRED', 'REWORKING',
  'BLOCKED', 'ESCALATED', 'REASSIGNED', 'CANCELLED', 'INTEGRATION_BLOCKED',
] as const;

export const DelegationStatusSchema = z.enum(DELEGATION_STATUSES);
export type DelegationStatus = z.infer<typeof DelegationStatusSchema>;

/** Every legal move, and nothing else is.
 *
 *  The table *is* the invariant. `MERGING` is reachable only from `ACCEPTED`,
 *  so "merge before the parent accepted" is not a rule callers must remember —
 *  it is a transition `updateDelegation` refuses to write. Likewise the only
 *  way out of `FEEDBACK_REQUIRED` that keeps the child is `REWORKING`, and the
 *  only way to a different child is `REASSIGNED`, which is never an edge out of
 *  a review on its own. */
const TRANSITIONS: Record<DelegationStatus, readonly DelegationStatus[]> = {
  ASSIGNED: ['WORKING', 'BLOCKED', 'ESCALATED', 'REASSIGNED', 'CANCELLED'],
  WORKING: ['REPORT_READY', 'BLOCKED', 'ESCALATED', 'REASSIGNED', 'CANCELLED'],
  REPORT_READY: ['UNDER_REVIEW', 'ESCALATED', 'CANCELLED'],
  UNDER_REVIEW: ['ACCEPTED', 'FEEDBACK_REQUIRED', 'ESCALATED', 'CANCELLED'],
  ACCEPTED: ['MERGING', 'CANCELLED'],
  MERGING: ['MERGED', 'INTEGRATION_BLOCKED'],
  MERGED: [],
  FEEDBACK_REQUIRED: ['REWORKING', 'BLOCKED', 'ESCALATED', 'REASSIGNED', 'CANCELLED'],
  REWORKING: ['REPORT_READY', 'BLOCKED', 'ESCALATED', 'REASSIGNED', 'CANCELLED'],
  // A conflict is not an implementation failure, so it has its own way back:
  // retry the merge once the base moves, or hand the conflict to the same child.
  INTEGRATION_BLOCKED: ['MERGING', 'FEEDBACK_REQUIRED', 'ESCALATED', 'CANCELLED'],
  BLOCKED: ['WORKING', 'REWORKING', 'ESCALATED', 'REASSIGNED', 'CANCELLED'],
  ESCALATED: ['WORKING', 'REWORKING', 'FEEDBACK_REQUIRED', 'REASSIGNED', 'CANCELLED'],
  REASSIGNED: [],
  CANCELLED: [],
};

export function canTransitionDelegation(from: DelegationStatus, to: DelegationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalDelegationTransitionError extends Error {
  constructor(id: string, readonly from: DelegationStatus, readonly to: DelegationStatus) {
    super(`Delegation ${id} cannot move ${from} → ${to}`);
  }
}

export function isTerminalDelegationStatus(status: DelegationStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** What the child hands its parent: structured facts plus references to the
 *  evidence, never the transcript. */
export const ChildReportSchema = z.object({
  assignmentId: z.string().min(1),
  status: z.enum(['ready', 'blocked']),
  summary: z.string(),
  completedWork: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  evidenceRefs: z.array(z.string()).default([]),
  testsRun: z.array(z.object({
    command: z.string(),
    passed: z.boolean(),
    evidenceId: z.string().optional(),
  })).default([]),
  assumptions: z.array(z.string()).default([]),
  uncertainties: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  remainingWork: z.array(z.string()).default([]),
});
export type ChildReport = z.infer<typeof ChildReportSchema>;

/** What the parent hands back when acceptance fails: only what the same child
 *  needs to fix it. */
export const ParentFeedbackSchema = z.object({
  assignmentId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  failedChecks: z.array(z.object({
    check: z.string(),
    observed: z.string(),
    expected: z.string(),
    evidenceRefs: z.array(z.string()).default([]),
  })).default([]),
  requiredChanges: z.array(z.string()).default([]),
  guidance: z.array(z.string()).default([]),
  nextChecks: z.array(z.string()).default([]),
});
export type ParentFeedback = z.infer<typeof ParentFeedbackSchema>;

/** Why ownership moved to a different child. Reassignment is a decision, so it
 *  carries its reason and what triggered it — it is never a retry. */
export const ReassignmentSchema = z.object({
  toAssignmentId: z.string().min(1),
  toChildId: z.string().min(1),
  reason: z.string().min(1),
  evidenceRefs: z.array(z.string()).default([]),
  /** Who or what authorised it: a person, an approval id, a market decision id. */
  decidedBy: z.string().min(1),
  at: z.string(),
});
export type Reassignment = z.infer<typeof ReassignmentSchema>;

export const WorkspaceRefSchema = z.object({
  /** The child's isolated worktree on the host. Retained until merged or cancelled. */
  path: z.string(),
  basePath: z.string(),
  revision: z.string(),
});
export type WorkspaceRef = z.infer<typeof WorkspaceRefSchema>;

/** The durable parent→child work contract.
 *
 *  `goal`, `definitionOfDone` (what the child must produce), `acceptanceChecks`
 *  (what the parent requires before taking responsibility for the work) and the
 *  authority/budget snapshot are fixed at assignment. Rework never changes them:
 *  a failed review can send the same child back, but it cannot widen what the
 *  child was allowed to spend or do. */
export const DelegationRecordSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().min(1),
  childId: z.string().min(1),
  goal: z.string().min(1),
  definitionOfDone: z.array(z.string()).default([]),
  acceptanceChecks: z.array(z.string()).default([]),
  /** Paths the child may write, when the parent granted a scope. Absent means no
   *  explicit scope — not "anything": protected paths (CI config, env files,
   *  manifests, lockfiles) always need an explicit grant. Fixed at assignment,
   *  like the budget. */
  writeScope: z.array(z.string()).optional(),
  /** Assignment ids this piece had to wait for. */
  dependencies: z.array(z.string()).default([]),
  status: DelegationStatusSchema,
  /** Bumped by every write, so a stale writer fails instead of overwriting. */
  revision: z.number().int().positive(),
  /** Execution dispatches under this assignment: 1 for the first run, +1 per rework. */
  attempt: z.number().int().positive(),
  budgetUsd: z.number().nonnegative(),
  authority: AuthoritySchema.optional(),
  workspace: WorkspaceRefSchema.optional(),
  report: ChildReportSchema.optional(),
  feedback: ParentFeedbackSchema.optional(),
  /** Earlier feedback, newest last and bounded, so a check failing repeatedly
   *  stays diagnosable. The event log holds the full audit history. */
  feedbackHistory: z.array(ParentFeedbackSchema).default([]),
  /** The assignment this one took over from. Set only by an explicit reassignment. */
  reassignedFrom: z.string().optional(),
  reassignment: ReassignmentSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DelegationRecord = z.infer<typeof DelegationRecordSchema>;

/** What a caller supplies to open an assignment. Status, revision and attempt
 *  are not the caller's to choose. */
export const NewDelegationSchema = DelegationRecordSchema.omit({
  status: true, revision: true, attempt: true, createdAt: true, updatedAt: true,
  report: true, feedback: true, feedbackHistory: true, reassignment: true,
});
export type NewDelegation = z.input<typeof NewDelegationSchema>;

/** The only fields a write may change. Everything that defines the contract —
 *  goal, DoD, acceptance checks, budget, authority, owner — is deliberately
 *  absent, so widening it is a type error and a runtime refusal. */
export const DelegationPatchSchema = z.object({
  status: DelegationStatusSchema.optional(),
  attempt: z.number().int().positive().optional(),
  workspace: WorkspaceRefSchema.optional(),
  report: ChildReportSchema.optional(),
  feedback: ParentFeedbackSchema.optional(),
  feedbackHistory: z.array(ParentFeedbackSchema).optional(),
  reassignment: ReassignmentSchema.optional(),
}).strict();
export type DelegationPatch = z.input<typeof DelegationPatchSchema>;
