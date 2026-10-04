# Hierarchical Work Ownership & Acceptance

## Goal

Turn delegation into a durable parent-child work contract:

`ASSIGN → WORK → REPORT → PARENT REVIEW → ACCEPT/FEEDBACK → MERGE`

Normal failure keeps the same child, assignment, worktree, context lineage, and evidence. Reassignment is exceptional.

## Core invariants

1. A child owns execution of an assigned work package; its parent owns acceptance.
2. Child completion means `REPORT_READY`, not final success.
3. A delegated assignment records goal, child definition-of-done, parent acceptance checks, authority/budget snapshot, dependencies, and lifecycle status.
4. Unaccepted child work remains isolated from the parent's authoritative worktree.
5. Acceptance checks run against the child's candidate changes before merge.
6. Only accepted work may merge into the parent worktree.
7. Failed acceptance sends structured feedback to the same child by default.
8. Reassignment is a separately recorded exceptional decision.
9. Existing failed-attempt evidence remains available for rework; it is not discarded or silently converted into success.
10. The existing node state machine remains the node state machine. Parent-child status is a durable relationship projection, not a second competing XState machine.
11. The economic/action market may choose whether to continue, validate, escalate, reassign, or cancel, but cannot override a hard acceptance failure.
12. Delegation remains recursive: any child may create the same kind of assignments for its own children.
13. Context handoffs use compact references/envelopes rather than parent transcripts.
14. Existing authority intersection, commitment reservation, budget allocation, workstream scheduling, recovery evidence, and fork isolation remain the underlying primitives.

## Assignment lifecycle

Core relationship statuses:

`ASSIGNED → WORKING → REPORT_READY → UNDER_REVIEW → ACCEPTED → MERGING → MERGED`

Failure loop:

`REPORT_READY → UNDER_REVIEW → FEEDBACK_REQUIRED → REWORKING → REPORT_READY`

Exceptional statuses:

`BLOCKED, ESCALATED, REASSIGNED, CANCELLED, INTEGRATION_BLOCKED`

## Contract semantics

### Child definition-of-done

Describes what the child must produce.

### Parent acceptance checks

Describes what the parent requires before taking responsibility for the work.

These are deliberately separate. A child can satisfy its DoD while still failing parent acceptance.

## Durable assignment record

The implementation should add a focused delegation record rather than overload node state or commitments.

Conceptual shape:

```ts
interface DelegationRecord {
  id: string;
  parentId: string;
  childId: string;
  goal: string;
  definitionOfDone: string[];
  acceptanceChecks: string[];
  dependencies: string[];
  status: DelegationStatus;
  revision: number;
  attempt: number;
  budgetUsd: number;
  createdAt: string;
  updatedAt: string;
}
```

The current row may additionally carry the latest `ChildReport` and `ParentFeedback` as JSON snapshots; the event log remains the audit history.

## Child report

The child reports structured facts plus evidence references:

```ts
interface ChildReport {
  assignmentId: string;
  status: 'ready' | 'blocked';
  summary: string;
  completedWork: string[];
  changedFiles: string[];
  evidenceRefs: string[];
  testsRun: Array<{ command: string; passed: boolean; evidenceId?: string }>;
  assumptions: string[];
  uncertainties: string[];
  blockers: string[];
  remainingWork: string[];
}
```

## Parent feedback

```ts
interface ParentFeedback {
  assignmentId: string;
  revision: number;
  failedChecks: Array<{ check: string; observed: string; expected: string; evidenceRefs: string[] }>;
  requiredChanges: string[];
  guidance: string[];
  nextChecks: string[];
}
```

## Acceptance-before-merge

The child fork remains live after `REPORT_READY`. The parent evaluates the child candidate tree. Only a passing acceptance result may call the existing fork integration primitive.

A failed acceptance does not release the child fork.

An integration conflict is not automatically an implementation failure. It enters `INTEGRATION_BLOCKED` and is handled separately.

## Rework versus reassignment

Default:

`same child + same assignment + same worktree + new revision + feedback`

Reassignment requires an explicit decision and a recorded reason. It must not be implemented as the ordinary validation retry path.

## Token-efficiency requirements

A rework handoff should contain only:

- assignment goal / DoD / acceptance checks
- latest parent feedback
- relevant evidence references
- previous report and concise failure evidence
- changed artifact/path references

Do not resend the parent's full transcript.

## Economic integration

Delegation remains the organizational spine. The economic engine remains the action/resource governor.

The market may evaluate the cost of more rework versus escalation/reassignment, but acceptance gates remain hard constraints.

## Out of scope for the first slice

- New permanent manager agents
- Fixed organizational depth
- UI redesign
- Replacing the Action Market
- Replacing the XState node lifecycle
- Automatic model-based arbitration of two conflicting child reports

## Implementation map

| Concern | Where |
|---|---|
| Statuses, legal transitions, record/report/feedback schemas | `src/schemas/delegation.ts` |
| Durable rows, revision compare-and-swap, retained-workspace listing | `src/db/queries/delegations.ts`, `delegations` table (migration `0011`) |
| Every status change, and its audit event, in one operation | `src/lifecycle/delegation-events.ts` (`transitionDelegation`) |
| Bounded report, feedback and rework-context builders | `src/lifecycle/delegation-reports.ts` |
| The parent's acceptance decision, from evidence | `src/lifecycle/delegation-review.ts` |
| The assign → report → review → accept/rework/reassign → merge loop | `src/lifecycle/delegate-child.ts` (`driveAssignment`, `requestRework`, `requestReassignment`) |
| The only path from a child's workspace to the parent's tree | `src/lifecycle/node-actor-manager.ts` (`mergeAcceptedDelegation`, over `integrateFork`) |
| A child's changed files, and what it may write | `src/execution/workspace-fork.ts` (`candidateChangedFiles`), `src/lifecycle/delegation-scope.ts` |
| Mechanical merge, and settling a conflict in the child's own worktree | `src/execution/workspace-fork.ts` (`integrateForkDetailed`, `rebaseForkOntoBase`, `filesWithConflictMarkers`) |
| Dependencies shared read-only into forked sandboxes | `src/k8s/sandbox-env.ts` (`dependencyMounts`) |
| What the parent holds each piece to (definition of done, evidenceable checks) | `src/intelligence/plan.ts` (`parsePlan`, `isEvidenceableCheck`) |
| Recovery after a refusal, priced by the market | `src/lifecycle/assignment-market.ts`, `src/lifecycle/node-actor-manager.ts` (`decideRecoveryFor`) |
| Resuming a delegation after a restart | `src/lifecycle/delegate-child.ts` (`needsResume`), `src/lifecycle/node-actor-manager.ts` (`delegateNode`), `src/db/queries/delegation-plans.ts` |

`INTEGRATION_BLOCKED` leaves the parent's tree exactly as it was; the candidate
is retained. `ESCALATED` is where an assignment goes when the rework limit is
reached or a governor declines another revision — never a silent replacement.

## Merge conflicts

Textual conflicts are settled cheapest-first: git's 3-way merge (edits to
different parts of one file merge with no help); then, for append-only files
only, keeping both sides; then the same child. The parent never resolves a
conflict itself — it would read two diffs it did not write, for code it does
not own. For the child, the worktree is moved onto the parent's current state
with the child's own work re-applied, and the overlap is left as conflict
markers in *its* tree; the parent's tree is not touched. A candidate that still
has markers is never accepted.

Cleanly mergeable is not the same as correct: two children can each merge
without conflict and still break each other. Verifying the integrated tree is
not yet built (see the audit).

## Recovery, and restarts

**After a refusal** the choice — the same child again, a different owner, or stop
and ask — is priced by the Action Market's own recovery model rather than fixed
by a count. Rework keeps what the child established; it is refused outright when
it would be the same idea again (the same checks failing a second time with
nothing gained), which is what makes a different owner reachable. A fresh owner
is priced as a from-scratch attempt plus the handoff. Where nothing has been
measured the market defers to the default, the same child reworked. It cannot
accept, and the hard limits — the rework cap, the reassignment cap, the child's
remaining budget — apply to whatever it says.

**After a restart** every non-terminal node is parked as `INTERRUPTED`, and
resuming the parent is the decision to carry the delegation on. The parent's
plan is kept beside its assignments; on resume each piece with a live assignment
is picked up at the status its record is in — reviewed if it had reported,
merged if it had been accepted, reworked if it had been refused — and a piece
that never got one is started. Nothing that finished is started again, and no
piece is assigned twice. Every write is a compare-and-swap on the assignment's
revision, so a second driver stands down instead of acting on a stale state.
