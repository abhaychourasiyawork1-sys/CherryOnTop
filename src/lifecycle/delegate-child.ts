import { randomUUID } from 'node:crypto';
import type { ExecuteStepResult } from '../execution/execute-step.js';
import { ZERO_USAGE } from '../execution/tokens.js';
import type { Authority } from '../schemas/node-contract.js';
import { effectiveAuthority } from '../engines/authority.js';
import { MIN_AGENT_BUDGET_USD } from '../engines/decide-execution.js';
import { planWorkstreams, dependentsOf, type WorkstreamNode, type WorkstreamPlan } from '../execution/workstreams.js';
import { extractAnchors } from '../efficiency/task-economics.js';
import { validateDelegationPlan, type DelegationValidationResult } from '../decision/delegation-validator.js';
import {
  canTransitionDelegation, IllegalDelegationTransitionError, DelegationStaleError, DelegationNotFoundError,
  type DelegationPatch, type DelegationRecord, type DelegationStatus, type NewDelegation,
  type ParentFeedback, type WorkspaceRef,
} from '../schemas/delegation.js';
import {
  buildChildDelegationReport, buildParentFeedback, compactReworkContext, reworkGoal,
} from './delegation-reports.js';
import { reviewChildWork, type ChildRunResult, type CheckVerifier } from './delegation-review.js';
import type { DelegationEventDetail } from './delegation-events.js';

export interface DelegateInput {
  parentId: string;
  goal: string;
  approvedBudgetUsd?: number;
  /** What the parent knows that its children should be told: its standing
   *  constraints, the turn budget they will run under, and the context its own
   *  projection already found relevant. Absent means a child is dispatched
   *  exactly as it was before envelopes existed. */
  handoff?: {
    constraints?: string[];
    maxTurns?: number;
    suggestedContext?: string[];
  };
  /** The goals to hand out, one per child. Empty means the planner could not
   *  split the goal. */
  subgoals?: string[];
  /** Aligned with `subgoals`: the indexes each one must wait for. Absent or
   *  empty means every piece is free to run at once, as before ordering could
   *  be expressed. */
  after?: number[][];
  /** The parent's own authority, so the plan can be checked against it before
   *  any child exists. Absent means the structural checks that need it are
   *  skipped — every pre-validator caller behaves exactly as before. */
  authority?: Authority;
  /** How many children this node already created. Delegation is a one-time act:
   *  if a fan-out came back with any piece unfinished, the machine's retry used
   *  to re-plan and create a *second* full set of children — duplicating the
   *  pieces that had already succeeded and spending the quota twice. */
  existingChildren?: number;
  /** Aligned with `subgoals`: what each child must produce. Absent means the
   *  minimal contract the subgoal itself states, as before children had a DoD of
   *  their own. */
  definitionOfDoneBySubgoal?: string[][];
  /** What the *parent* requires of every child's candidate work before it takes
   *  responsibility for it — separate from the child's DoD, which says what the
   *  child must produce. Empty is a deliberate choice of zero extra parent
   *  checks (the child's own validation still has to hold); it is never a
   *  silently dropped list. */
  acceptanceChecks?: string[];
  /** Aligned with `subgoals`: parent checks specific to one piece, added to
   *  `acceptanceChecks`. */
  acceptanceChecksBySubgoal?: string[][];
  /** Aligned with `subgoals`: the paths each child may write. Granted, never
   *  inferred — an entry left undefined grants no explicit scope, and protected
   *  paths (CI config, env files, manifests, lockfiles) need an explicit grant
   *  either way. The review checks the child's diff against it. */
  writeScopeBySubgoal?: Array<string[] | undefined>;
  /** This parent already delegated and was restarted: pick the work up where the
   *  durable assignments say it is, instead of refusing to split a second time.
   *  Pieces that already have an assignment are resumed (or left alone, if they
   *  settled); pieces that never got one are started. Set only when
   *  `needsResume` says there is something to resume. */
  resume?: boolean;
}

/**
 * The authority a child is created with: a share of what its parent holds.
 *
 * Both limits are **pools the parent divides**, not counters it decrements.
 * That distinction is the whole fix for two bugs that had the same cause:
 *
 *  - `max_child_count` is the number of agents allowed in this node's *whole
 *    subtree*, not the number of children it may create. Creating k children
 *    spends k of it, and the remainder is split evenly among them. Decrementing
 *    by one per generation, as this used to, bounds depth and nothing else: a
 *    root allowed "5" produced a 57-agent organization five levels deep, while
 *    the interface cheerfully promised at most six.
 *
 *  - the budget is divided into k+1 shares, one per child and one kept back for
 *    the parent's own planning and synthesis runs — which are real dispatches
 *    that spend real money. Children used to get a flat $1 regardless of what
 *    the parent held, so a $25 root funded 57 agents at $1 each.
 *
 * Both properties are proved by induction in the tests: an organization can
 * never exceed max_child_count + 1 agents, nor its root's budget.
 *
 * `approvedBudgetUsd`, when set, is a human's explicit grant and is the one
 * thing that may exceed the parent's own share.
 */
export function childAuthority(
  parent: Authority,
  siblingCount: number,
  approvedBudgetUsd?: number,
  /** A ceiling on what this child may hold, applied last. A reassignment passes
   *  what the previous owner had left, so handing work to a different child can
   *  never mint budget the split did not allocate. */
  budgetCapUsd?: number,
  /** What a child would need to afford a split of its own piece, priced by the
   *  market. Absent means nothing has priced it, and the child's own delegation
   *  decision (which escalates when the authority is short) is the check. */
  minSplitBudgetUsd?: number,
): Authority {
  const siblings = Math.max(1, Math.floor(siblingCount));

  // Agents left for the whole subtree after this generation is created, split
  // evenly. Floor, so rounding can only ever under-allocate — never breach.
  const eachAllowance = Math.max(0, Math.floor((parent.max_child_count - siblings) / siblings));

  // One share per child, plus one the parent keeps: it still has to pay for the
  // planning run that produced these subgoals and the synthesis run that will
  // combine their answers.
  const share = parent.budget_usd / (siblings + 1);

  // There is no platform-policy concept in the codebase yet (doc §8 describes
  // one, nothing implements it), so the parent's own authority stands in as the
  // platform maximum — raised by an approval when there is one.
  const granted: Authority = approvedBudgetUsd === undefined
    ? parent
    : { ...parent, budget_usd: Math.max(parent.budget_usd, approvedBudgetUsd) };

  const authority = effectiveAuthority(granted, granted, {
    ...granted,
    budget_usd: approvedBudgetUsd ?? share,
    max_child_count: eachAllowance,
    spawn_children: eachAllowance > 0,
  });

  const capped: Authority = budgetCapUsd === undefined
    ? authority
    : { ...authority, budget_usd: Math.min(authority.budget_usd, Math.max(0, budgetCapUsd)) };

  return {
    ...capped,
    // Spawn authority a child could never afford to use only sends it straight
    // to ESCALATE, asking a human to approve the same delegation one generation
    // down. It needs enough for its own plan, a piece of work and the
    // synthesis — as the market prices them, not as a constant guesses.
    spawn_children: capped.spawn_children
      && (minSplitBudgetUsd === undefined || capped.budget_usd >= minSplitBudgetUsd),
  };
}

export interface AuthorityAllocationInput {
  parent: Authority;
  childCount: number;
  /** What the parent keeps for its own planning and synthesis runs. Those are
   *  real dispatches that spend real money, and a fan-out that allocates every
   *  dollar to children cannot afford to combine their answers. */
  reserveBudgetUsd: number;
}

export interface AuthorityAllocationResult {
  childBudgetsUsd: number[];
  totalAllocatedUsd: number;
  remainingParentBudgetUsd: number;
}

/** Child budgets under an explicit reserve.
 *
 *  `childAuthority` above derives the whole child contract and reserves exactly
 *  one share of k+1 — the right default when nobody has costed the parent's own
 *  runs. This is the same arithmetic with the reserve named outright, for the
 *  caller that has measured what planning and synthesis will cost.
 *
 *  The invariant both share: children can never be allocated more than the
 *  parent holds, whatever is passed in. A reserve wider than the budget leaves
 *  zero for children rather than a negative share. */
export function allocateChildAuthority(input: AuthorityAllocationInput): AuthorityAllocationResult {
  const children = Math.max(0, Math.floor(input.childCount));
  const budget = Math.max(0, input.parent.budget_usd);
  const reserve = Math.min(budget, Math.max(0, input.reserveBudgetUsd));
  const allocatable = Math.max(0, budget - reserve);
  const each = children === 0 ? 0 : allocatable / children;
  return {
    childBudgetsUsd: Array.from({ length: children }, () => each),
    totalAllocatedUsd: each * children,
    remainingParentBudgetUsd: budget - each * children,
  };
}

/** Delegated, and *how*.
 *
 *  Two separate questions, and this is the one that must not be answered by the
 *  first. A validated plan whose branches must run in order is
 *  `SERIAL_DELEGATED`, which is a good outcome — not a parallel run that
 *  degraded. Parallel needs two things to be true at once: the graph has a
 *  group with more than one branch in it, and the economic ranking actually
 *  preferred running them together over running them in order. */
export function delegationTopology(
  plan: WorkstreamPlan,
  selectedActionKinds: readonly string[],
): 'SERIAL_DELEGATED' | 'PARALLEL_DELEGATED' {
  const concurrent = plan.parallelGroups.some((group) => group.length > 1);
  return concurrent && selectedActionKinds.includes('parallelize')
    ? 'PARALLEL_DELEGATED'
    : 'SERIAL_DELEGATED';
}

/** What a child is told about its assignment, in compact form. */
export interface AssignmentContract {
  definitionOfDone: string[];
  acceptanceChecks: string[];
  writeScope?: string[];
}

/** The durable work contract, as the delegation loop sees it.
 *
 *  An interface rather than the database, so the loop's behaviour — and above
 *  all its *ordering* — is testable without one, and so the production ledger
 *  (`node-actor-manager.ts`) and the in-memory one below are held to the same
 *  transition table. Every status change in the loop goes through `transition`;
 *  `merge` is the only way an ACCEPTED assignment reaches the parent's tree. */
export interface DelegationLedger {
  open(input: Omit<NewDelegation, 'id'>): DelegationRecord;
  /** `expectedRevision` makes the write a compare-and-swap: it is refused, with
   *  `DelegationStaleError`, if the assignment has moved since the caller last
   *  read it. Every write the loop makes passes it, so two drivers on one
   *  assignment (a resumed parent racing a leftover, a recovery pass) cannot
   *  both act on the same state. */
  transition(
    id: string, to: DelegationStatus, patch?: DelegationPatch, detail?: DelegationEventDetail,
    options?: { expectedRevision?: number },
  ): DelegationRecord;
  get(id: string): DelegationRecord | undefined;
  /** Every assignment this parent has made, oldest first — reassigned owners
   *  included. What a restarted parent reads to find where its work is. */
  listForParent(parentId: string): DelegationRecord[];
  /** Integrates an ACCEPTED assignment's candidate into the parent's tree:
   *  ACCEPTED → MERGING → MERGED, or INTEGRATION_BLOCKED when it does not apply.
   *  Refuses anything not ACCEPTED — or MERGING, which is a merge a restart cut
   *  off and is finished rather than begun again. */
  merge(id: string): Promise<'MERGED' | 'INTEGRATION_BLOCKED'>;
}

export interface MemoryLedger extends DelegationLedger {
  list(): DelegationRecord[];
}

export interface MemoryLedgerOptions {
  /** The mechanical merge. Absent means there is no separate workspace to
   *  integrate: the child worked in the parent's own tree. */
  integrate?: (record: DelegationRecord) => boolean | Promise<boolean>;
  onTransition?: (record: DelegationRecord, from: DelegationStatus | null) => void;
}

/** A ledger with no storage, enforcing the same legal moves as the real one.
 *  The default when a deployment supplies none, and what the loop's own tests
 *  run against. */
export function createMemoryLedger(options: MemoryLedgerOptions = {}): MemoryLedger {
  const records = new Map<string, DelegationRecord>();
  let clock = 0;
  const stamp = () => `t${String(++clock).padStart(6, '0')}`;

  const ledger: MemoryLedger = {
    open(input) {
      const now = stamp();
      const record: DelegationRecord = {
        ...input, id: randomUUID(),
        definitionOfDone: input.definitionOfDone ?? [], acceptanceChecks: input.acceptanceChecks ?? [],
        dependencies: input.dependencies ?? [],
        status: 'ASSIGNED', revision: 1, attempt: 1, feedbackHistory: [], createdAt: now, updatedAt: now,
      };
      records.set(record.id, record);
      options.onTransition?.(record, null);
      return record;
    },
    transition(id, to, patch = {}, _detail, transitionOptions) {
      const current = records.get(id);
      if (!current) throw new DelegationNotFoundError(id);
      if (transitionOptions?.expectedRevision !== undefined && transitionOptions.expectedRevision !== current.revision) {
        throw new DelegationStaleError(id, transitionOptions.expectedRevision, current.revision);
      }
      if (to !== current.status && !canTransitionDelegation(current.status, to)) {
        throw new IllegalDelegationTransitionError(id, current.status, to);
      }
      const next: DelegationRecord = {
        ...current, ...patch, status: to, revision: current.revision + 1, updatedAt: stamp(),
      } as DelegationRecord;
      records.set(id, next);
      options.onTransition?.(next, current.status);
      return next;
    },
    get: (id) => records.get(id),
    list: () => [...records.values()],
    listForParent: (parentId) => [...records.values()].filter((record) => record.parentId === parentId),
    async merge(id) {
      const record = records.get(id);
      if (!record) throw new DelegationNotFoundError(id);
      // A merge the restart cut off is already MERGING: finish it.
      if (record.status !== 'MERGING') ledger.transition(id, 'MERGING');
      const merged = options.integrate ? await options.integrate(record) : true;
      const done = ledger.transition(id, merged ? 'MERGED' : 'INTEGRATION_BLOCKED');
      return done.status === 'MERGED' ? 'MERGED' : 'INTEGRATION_BLOCKED';
    },
  };
  return ledger;
}

/** What to do about work the parent has just refused.
 *
 *  This is the *only* thing the economic layer (or a person) may decide after a
 *  failed acceptance: keep the same child working, hand the work to a different
 *  one, stop and ask, or stop. There is deliberately no "accept" — acceptance is
 *  the review's verdict, and a decision that cannot say it cannot override it. */
export type RecoveryDecision =
  | { action: 'rework' }
  /** A different child takes over. Ordinary failure never gets here on its own:
   *  it takes a decision that names a reason and who made it. */
  | { action: 'reassign'; reason: string; decidedBy: string; evidenceRefs?: string[] }
  | { action: 'escalate'; reason: string }
  | { action: 'cancel'; reason: string };

export interface RecoveryContext {
  assignment: DelegationRecord;
  feedback: ParentFeedback;
  /** Reworks already spent on this assignment under its current owner. */
  reworks: number;
  run: ChildRunResult;
}

/** How many times the *same* child is sent back after a failed review, before
 *  the parent stops spending on it and asks for a decision. Total dispatches for
 *  one owner are therefore one more than this — the same budget of attempts the
 *  old fresh-sibling loop allowed, now spent on one child that keeps its
 *  workspace and its context. A hard cap: no decision can raise it. */
export const MAX_REWORK_REVISIONS = 2;

/** Conflict reworks per assignment: how many times the same child is asked to
 *  settle a merge conflict in its own workspace. One is enough to tell a genuine
 *  disagreement from a stale base; if it still does not merge, that is a
 *  decision for someone else, not a loop. It also counts toward
 *  `MAX_REWORK_REVISIONS`. */
export const MAX_CONFLICT_REWORKS = 1;

/** Reassignments per piece of work, however they were decided. A decision is
 *  required for each; this bounds a governor that keeps deciding the same way. */
export const MAX_REASSIGNMENTS = 2;

export interface DelegateChildDeps {
  /** Records what the parent addressed to this child. Optional: a deployment
   *  with no envelope store dispatches children exactly as before. */
  recordEnvelope?: (childId: string, goal: string, budgetUsd: number, contract?: AssignmentContract) => void;
  /** `siblingCount` rather than a budget: what a child may hold is derived from
   *  its parent and how many ways the work was split, so no caller is in a
   *  position to decide it. `budgetCapUsd` is only ever a ceiling (a reassigned
   *  child gets at most what its predecessor had left). */
  createChildNode: (
    parentId: string, goal: string, siblingCount: number, approvedBudgetUsd?: number, budgetCapUsd?: number,
  ) => string;
  recordCommitment: (childId: string, goal: string, definitionOfDone?: string[]) => void;
  /** Starts a child — or *re-enters* one: the same node, given its rework goal. */
  startChild: (childId: string, goal: string) => void;
  /** Resolves when the child's *execution* is over, with what it left behind.
   *  It says nothing about acceptance and never merges anything: a finished
   *  child is a reported child, not an accepted one. `cancelled` means someone
   *  stopped it on purpose — it is never replaced, and nothing that depends on
   *  it starts. */
  waitForChild: (childId: string) => Promise<ChildRunResult>;
  /** True once the delegating node itself has been stopped. Checked before
   *  every child is created and before any rework: the delegation loop is plain
   *  async code that outlives its node's cancellation. Optional; absent means
   *  never. */
  parentStopped?: () => boolean;
  /** What the work graph said and what it cost. Optional: a deployment with no
   *  telemetry sink schedules exactly the same, it just says nothing about it. */
  recordSchedule?: (schedule: DelegationSchedule) => void;
  /** Why a plan was funded or refused. Optional, for the same reason. */
  recordPlanValidation?: (validation: DelegationValidationResult) => void;
  /** A child's own final report, read back so a dependent piece can be told what
   *  the pieces it waited for found. */
  getFindings?: (childId: string) => string;
  /** Where the assignments are kept. Absent means in memory, under the same
   *  transition rules. */
  ledger?: DelegationLedger;
  /** The budget/authority snapshot and isolated workspace the child was created
   *  with, so the assignment records them instead of recomputing them. */
  describeChild?: (childId: string) => { budgetUsd?: number; authority?: DelegationRecord['authority']; workspace?: WorkspaceRef } | undefined;
  /** Re-opens what a finished child's own terminal handler closed, so the same
   *  child can be given another revision. */
  reopenChild?: (childId: string) => void;
  /** Releases a child's isolated workspace. Called only when the assignment
   *  ends without a merge for good — cancelled, or handed to another owner. Never
   *  after a failed review, which keeps the workspace for the rework. */
  discardWorkspace?: (assignment: DelegationRecord) => void;
  /** What a child has left to spend, so a reassignment can be capped at it. */
  remainingBudget?: (childId: string) => number | undefined;
  /** Fresh evidence for an acceptance check the child's own trace cannot supply,
   *  about *this* assignment's candidate — siblings have different workspaces. */
  verifyCheck?: (check: string, assignment: DelegationRecord) => ReturnType<CheckVerifier>;
  /** The economic governor's say after a failed review. Absent means rework
   *  until the limit, then escalate. */
  decideRecovery?: (context: RecoveryContext) => RecoveryDecision | Promise<RecoveryDecision>;
  /** Readies an accepted child whose merge conflicted for a rework that settles
   *  the conflict *where the child can see both sides*: its workspace is moved
   *  onto the parent's current state with its own work re-applied, leaving any
   *  overlap as markers. Returns the conflicting files; an empty list means the
   *  rebase was clean and the merge can simply be retried; null means it could
   *  not be done, and the assignment stays INTEGRATION_BLOCKED. Absent means a
   *  conflict is left as it is. */
  prepareConflictRework?: (assignment: DelegationRecord) => { conflicts: string[] } | null;
  /** Links an old owner to the child that took over from it — explicit
   *  reassignment only, never a retry. */
  markSuperseded?: (failedId: string, replacementId: string) => void;
}

/** The subgoals, as a graph the scheduler can reason about.
 *
 *  A planner hands back sentences, not a DAG, so the structure has to be read
 *  back out of them. Only one thing is inferred, and it is the one that is a
 *  correctness failure rather than a cost: two subgoals that will *write* the
 *  same file. `planWorkstreams` puts those in different groups; everything else
 *  stays in one group and runs together, which is what a fan-out was already
 *  doing.
 *
 *  Every named path is an information dependency too — two branches reading one
 *  module is not a conflict, it is the duplication `sharedEvidenceIds` exists to
 *  name.
 *
 *  ponytail: anchors are a heuristic for write paths; a planner that emitted
 *  explicit file claims per subgoal would replace this whole function. */
export function workstreamNodesFor(subgoals: string[], after: number[][] = []): WorkstreamNode[] {
  return subgoals.map((goal, index) => {
    const anchors = extractAnchors(goal);
    return {
      id: String(index),
      // The planner's own ordering, when it gave one: "build the site after
      // both research pieces" is a real input dependency, and before it could
      // be said the planner's only honest answer to such a goal was [].
      inputDependencies: (after[index] ?? []).map(String),
      informationDependencies: anchors,
      outputDependencies: [],
      validationDependencies: [],
      // Unless something says a piece only reads, it is assumed to write what it
      // names: assuming it writes nothing is the assumption that costs a race
      // between siblings, where assuming it writes costs a little parallelism.
      writePaths: anchors,
    };
  });
}

export interface DelegationSchedule {
  plan: WorkstreamPlan;
  /** What the graph actually allowed, once ordering and write conflicts had
   *  their say. The strategy gate names an *intent* before the plan exists;
   *  this is the outcome, and learning needs both to tell whether delegating
   *  serially was the right call. */
  topology: 'SERIAL_DELEGATED' | 'PARALLEL_DELEGATED';
  /** Children never started because something they depended on failed, with the
   *  reason. Empty on a clean fan-out. */
  cancelled: { goal: string; reason: string }[];
}

/** What all of a piece's prerequisite reports may cost together, in characters,
 *  and the most any one may take. A dependent that waits on four pieces used to
 *  be handed four reports of up to 4,000 characters each regardless of what else
 *  it was carrying; the total is now bounded and shared out. */
export const PREREQUISITE_CHARS_TOTAL = 12_000;
export const PREREQUISITE_CHARS_EACH = 4_000;

/** Splits a shared allowance across items of different sizes without wasting it:
 *  a short report that needs less than its equal share leaves the remainder for
 *  the long ones ("water-filling"). Deterministic. */
export function fairShares(lengths: number[], total: number, cap: number): number[] {
  const shares = lengths.map(() => 0);
  let remaining = total;
  let open = lengths.map((_, i) => i).sort((a, b) => lengths[a] - lengths[b] || a - b);
  while (open.length > 0 && remaining > 0) {
    const equal = Math.floor(remaining / open.length);
    const index = open[0];
    const need = Math.min(cap, lengths[index]);
    if (need <= equal) {
      shares[index] = need;
      remaining -= need;
      open = open.slice(1);
    } else {
      // Everyone left needs more than an equal share: give each exactly that.
      for (const i of open) shares[i] = Math.min(cap, equal);
      break;
    }
  }
  return shares;
}

/** A dependent piece's goal, with what the pieces it waited for reported.
 *  Their files already reached its tree (a piece only finishes once the parent
 *  accepted and merged it, and a new fork carries the parent's working tree);
 *  the reports say where to look, so it does not rediscover them. */
function withPrerequisites(goal: string, reports: { goal: string; findings: string }[]): string {
  const usable = reports.filter((report) => report.findings.trim());
  if (usable.length === 0) return goal;
  const texts = usable.map((report) => report.findings.trim());
  const shares = fairShares(texts.map((t) => t.length), PREREQUISITE_CHARS_TOTAL, PREREQUISITE_CHARS_EACH);
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n[…clipped]` : text);
  return `${goal}\n\nThis piece builds on work already finished. What it reported:\n\n${usable
    .map((report, i) => `### ${report.goal}\n${clip(texts[i], shares[i])}`).join('\n\n')}`;
}

/** Everything the assignment lifecycle needs that is not one piece's own state. */
export interface AssignmentContext {
  deps: DelegateChildDeps;
  ledger: DelegationLedger;
  parentId: string;
  siblingCount: number;
  approvedBudgetUsd?: number;
  /** Merges queue here, one at a time. Accepted siblings are independent, but
   *  integrating two onto the same tree at once is how a write gets lost. */
  mergeChain: Promise<unknown>;
}

interface Piece {
  /** Its position in the parent's plan. */
  index: number;
  /** The piece as planned: what a person reads, and what a rework is told it is
   *  still trying to do. */
  baseGoal: string;
  /** What the child was dispatched with: the goal plus what its prerequisites reported. */
  goal: string;
  contract: AssignmentContract;
  dependencies: string[];
}

/** How one piece of work ended. `status` is the assignment's, so the caller can
 *  tell a merge that conflicted from a piece that never passed review. */
interface PieceOutcome {
  childId: string;
  assignmentId: string;
  status: DelegationStatus;
}

/** Opens the assignment and starts the child on it. The contract is written down
 *  first: a child that started before its assignment existed would be working on
 *  something nobody had said the parent would review. */
function assignPiece(ctx: AssignmentContext, piece: Piece): { record: DelegationRecord; childId: string } {
  const { deps, ledger } = ctx;
  const childId = deps.createChildNode(ctx.parentId, piece.goal, ctx.siblingCount, ctx.approvedBudgetUsd);
  const described = deps.describeChild?.(childId);
  const record = ledger.open({
    parentId: ctx.parentId, childId, goal: piece.baseGoal, piece: piece.index,
    definitionOfDone: piece.contract.definitionOfDone,
    acceptanceChecks: piece.contract.acceptanceChecks,
    ...(piece.contract.writeScope ? { writeScope: piece.contract.writeScope } : {}),
    dependencies: piece.dependencies,
    budgetUsd: described?.budgetUsd ?? ctx.approvedBudgetUsd ?? 0,
    ...(described?.authority ? { authority: described.authority } : {}),
    ...(described?.workspace ? { workspace: described.workspace } : {}),
  });
  deps.recordCommitment(childId, piece.goal, piece.contract.definitionOfDone);
  // Before the child starts, not after: the envelope is what its first
  // dispatch reads, and a child that started first would read nothing.
  deps.recordEnvelope?.(childId, piece.goal, ctx.approvedBudgetUsd ?? 0, piece.contract);
  const working = ledger.transition(record.id, 'WORKING');
  deps.startChild(childId, piece.goal);
  return { record: working, childId };
}

/** The normal answer to a failed review: the same child, told what failed, in
 *  the workspace that already holds its work.
 *
 *  Nothing here creates a node or a worktree. The child's own row is re-entered
 *  through `startChild`, so its commitments, envelope, authority and budget are
 *  exactly the ones it had — a rework cannot widen any of them. */
export function requestRework(ctx: AssignmentContext, assignmentId: string, baseGoal: string): DelegationRecord {
  const { deps, ledger } = ctx;
  const current = ledger.get(assignmentId);
  if (!current) throw new Error(`Delegation ${assignmentId} does not exist`);
  if (!current.feedback) throw new Error(`Delegation ${assignmentId} has no feedback to rework against`);
  const reworking = ledger.transition(assignmentId, 'REWORKING', { attempt: current.attempt + 1 }, {
    reason: 'sent back to the same child with the parent\'s feedback',
    evidenceRefs: current.feedback.failedChecks.flatMap((failed) => failed.evidenceRefs),
  }, { expectedRevision: current.revision });
  const context = compactReworkContext({
    goal: baseGoal, definitionOfDone: reworking.definitionOfDone, acceptanceChecks: reworking.acceptanceChecks,
    feedback: current.feedback, ...(current.report ? { previousReport: current.report } : {}),
    feedbackHistory: current.feedbackHistory,
  });
  deps.reopenChild?.(reworking.childId);
  deps.startChild(reworking.childId, reworkGoal(baseGoal, context));
  return reworking;
}

export class ReassignmentRefused extends Error {}

/** The exceptional answer: a different child takes the work over.
 *
 *  Only ever called with an explicit decision that names a reason and who made
 *  it — and never by the failure path itself. The old assignment ends
 *  REASSIGNED and points at its successor; the successor points back. The new
 *  child is capped at what the old one had left, so changing owner cannot mint
 *  budget the original split did not allocate. */
export function requestReassignment(
  ctx: AssignmentContext,
  assignmentId: string,
  decision: Extract<RecoveryDecision, { action: 'reassign' }>,
  piece: Piece,
): { record: DelegationRecord; childId: string } {
  const { deps, ledger } = ctx;
  const old = ledger.get(assignmentId);
  if (!old) throw new Error(`Delegation ${assignmentId} does not exist`);
  if (!decision.reason?.trim() || !decision.decidedBy?.trim()) {
    throw new ReassignmentRefused('a reassignment needs a reason and a decider');
  }
  if (!canTransitionDelegation(old.status, 'REASSIGNED')) {
    throw new ReassignmentRefused(`an assignment that is ${old.status} cannot be reassigned`);
  }
  const remaining = deps.remainingBudget?.(old.childId);
  if (remaining !== undefined && remaining < MIN_AGENT_BUDGET_USD) {
    throw new ReassignmentRefused('the current owner has too little budget left to fund a replacement');
  }

  const context = compactReworkContext({
    goal: piece.baseGoal, definitionOfDone: old.definitionOfDone, acceptanceChecks: old.acceptanceChecks,
    feedback: old.feedback ?? { assignmentId: old.id, revision: old.revision, failedChecks: [], requiredChanges: [], guidance: [], nextChecks: [] },
    ...(old.report ? { previousReport: old.report } : {}),
    feedbackHistory: old.feedbackHistory, handoff: 'reassignment',
  });
  const goal = reworkGoal(piece.goal, context);

  const childId = deps.createChildNode(ctx.parentId, piece.baseGoal, ctx.siblingCount, ctx.approvedBudgetUsd, remaining);
  const described = deps.describeChild?.(childId);
  const successor = ledger.open({
    parentId: ctx.parentId, childId, goal: old.goal,
    ...(old.piece === undefined ? {} : { piece: old.piece }),
    definitionOfDone: old.definitionOfDone, acceptanceChecks: old.acceptanceChecks,
    ...(old.writeScope ? { writeScope: old.writeScope } : {}),
    dependencies: old.dependencies, reassignedFrom: old.id,
    budgetUsd: described?.budgetUsd ?? (remaining === undefined ? old.budgetUsd : Math.min(old.budgetUsd, remaining)),
    ...(described?.authority ? { authority: described.authority } : {}),
    ...(described?.workspace ? { workspace: described.workspace } : {}),
  });
  ledger.transition(old.id, 'REASSIGNED', {
    reassignment: {
      toAssignmentId: successor.id, toChildId: childId, reason: decision.reason,
      evidenceRefs: decision.evidenceRefs ?? [], decidedBy: decision.decidedBy, at: new Date().toISOString(),
    },
  }, { reason: decision.reason, ...(decision.evidenceRefs ? { evidenceRefs: decision.evidenceRefs } : {}) },
  { expectedRevision: old.revision });
  deps.markSuperseded?.(old.childId, childId);
  // The old owner's assignment is over; its candidate is no longer anyone's to
  // merge. What it established travels in the handoff above.
  deps.discardWorkspace?.(old);

  deps.recordCommitment(childId, goal, old.definitionOfDone);
  deps.recordEnvelope?.(childId, goal, ctx.approvedBudgetUsd ?? 0, {
    definitionOfDone: old.definitionOfDone, acceptanceChecks: old.acceptanceChecks,
    ...(old.writeScope ? { writeScope: old.writeScope } : {}),
  });
  const working = ledger.transition(successor.id, 'WORKING');
  deps.startChild(childId, goal);
  return { record: working, childId };
}

function cancelAssignment(ctx: AssignmentContext, record: DelegationRecord, reason: string): DelegationRecord {
  const cancelled = canTransitionDelegation(record.status, 'CANCELLED')
    ? ctx.ledger.transition(record.id, 'CANCELLED', {}, { reason }, { expectedRevision: record.revision })
    : record;
  // A cancelled assignment is an explicit terminal cleanup: nothing will merge it.
  ctx.deps.discardWorkspace?.(cancelled);
  return cancelled;
}

function escalateAssignment(ctx: AssignmentContext, record: DelegationRecord, reason: string): DelegationRecord {
  // The workspace stays: an escalated piece is waiting on a decision, and its
  // candidate and evidence are what that decision is about.
  return canTransitionDelegation(record.status, 'ESCALATED')
    ? ctx.ledger.transition(record.id, 'ESCALATED', {}, { reason }, { expectedRevision: record.revision })
    : record;
}

/** One merge at a time, in the order they were accepted. */
function serialMerge(ctx: AssignmentContext, assignmentId: string): Promise<'MERGED' | 'INTEGRATION_BLOCKED'> {
  const run = ctx.mergeChain.then(() => ctx.ledger.merge(assignmentId));
  ctx.mergeChain = run.then(() => undefined, () => undefined);
  return run;
}

/** What the governor said, made safe to act on: a decision that cannot be acted
 *  on, or that would exceed a hard limit, becomes an escalation — never a merge,
 *  never a silent extra attempt. */
async function recoveryDecision(
  ctx: AssignmentContext, context: RecoveryContext, reassignments: number,
): Promise<RecoveryDecision> {
  let decision: RecoveryDecision = { action: 'rework' };
  try {
    decision = (await ctx.deps.decideRecovery?.(context)) ?? decision;
  } catch (err) {
    return { action: 'escalate', reason: `the recovery decision failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  switch (decision.action) {
    case 'rework':
      return context.reworks >= MAX_REWORK_REVISIONS
        ? { action: 'escalate', reason: `the same child was sent back ${MAX_REWORK_REVISIONS} times and the work is still not acceptable` }
        : decision;
    case 'reassign':
      if (!decision.reason?.trim() || !decision.decidedBy?.trim()) {
        return { action: 'escalate', reason: 'a reassignment was proposed without a reason and a decider' };
      }
      return reassignments >= MAX_REASSIGNMENTS
        ? { action: 'escalate', reason: `this work was already reassigned ${MAX_REASSIGNMENTS} times` }
        : decision;
    case 'escalate':
    case 'cancel':
      return decision.reason?.trim() ? decision : { ...decision, reason: `${decision.action} requested` };
    default:
      return { action: 'escalate', reason: 'an unrecognised recovery decision' };
  }
}

/** The check text a conflict rework is recorded under, so a resumed driver can
 *  tell how many it has already spent. */
const CONFLICT_CHECK = 'the change merges cleanly onto the parent tree';

/** Conflict reworks this assignment has already had, read from its own record. */
function conflictReworksSpent(record: DelegationRecord): number {
  return [...record.feedbackHistory, ...(record.feedback ? [record.feedback] : [])]
    .filter((feedback) => feedback.failedChecks.some((failed) => failed.check === CONFLICT_CHECK)).length;
}

/** How many owners this piece has already been through, by following the chain. */
function reassignmentDepth(ledger: DelegationLedger, record: DelegationRecord): number {
  let depth = 0;
  for (let at = record; at.reassignedFrom && depth < 20;) {
    const previous = ledger.get(at.reassignedFrom);
    if (!previous) break;
    depth++;
    at = previous;
  }
  return depth;
}

/** Carries one assignment from wherever it is to its end: reported, reviewed,
 *  and then either accepted and merged, or sent back — to the same child.
 *
 *  **Driven by the record's status, not by where the code happens to be.** Each
 *  pass looks at the status and does the one thing that status calls for, so the
 *  same loop serves a fresh assignment and one a restart left half-done: a
 *  parent that comes back to a child at `REPORT_READY` reviews it, at `ACCEPTED`
 *  merges it, at `FEEDBACK_REQUIRED` decides and reworks it — and never starts a
 *  child that already finished. Nothing it needs is held in memory that a
 *  restart would lose; what is (the latest run) is re-read when missing.
 *
 *  Every write is a compare-and-swap on the revision it last read. If something
 *  else moved the assignment — a second driver, a recovery pass — this one
 *  stands down rather than act on a state it has not seen.
 *
 *  Each pass through rework is one revision. The child finishing is
 *  REPORT_READY; only the parent's review turns that into ACCEPTED; only
 *  ACCEPTED can merge. */
async function driveAssignment(
  ctx: AssignmentContext, piece: Piece, started: { record: DelegationRecord; childId: string },
): Promise<PieceOutcome> {
  const { deps, ledger } = ctx;
  let { record, childId } = started;
  let reworks = Math.max(0, record.attempt - 1);
  let conflictReworks = conflictReworksSpent(record);
  let reassignments = reassignmentDepth(ledger, record);
  /** The child's latest result. Absent after a restart until it is read back. */
  let run: ChildRunResult | undefined;
  const outcome = (finalRecord: DelegationRecord): PieceOutcome =>
    ({ childId, assignmentId: finalRecord.id, status: finalRecord.status });
  const move = (to: DelegationStatus, patch: DelegationPatch = {}, detail?: DelegationEventDetail) => {
    record = ledger.transition(record.id, to, patch, detail, { expectedRevision: record.revision });
    return record;
  };

  try {
    for (;;) {
      switch (record.status) {
        case 'ASSIGNED': {
          // Opened but never started: the restart came between the two.
          move('WORKING');
          deps.startChild(childId, piece.goal);
          break;
        }

        case 'BLOCKED':
        case 'WORKING':
        case 'REWORKING': {
          if (record.status === 'BLOCKED') move('WORKING');
          try {
            run = await deps.waitForChild(childId);
          } catch (err) {
            // The wait itself failed (a timeout): the child may still be running.
            // The contract says so rather than staying WORKING for ever.
            if (canTransitionDelegation(record.status, 'BLOCKED')) {
              move('BLOCKED', {}, { reason: err instanceof Error ? err.message : String(err) });
            }
            throw err;
          }
          // Stopped on purpose: not reviewed, not reworked, not replaced.
          if (run.cancelled) return outcome(cancelAssignment(ctx, record, 'the child was stopped'));
          const report = buildChildDelegationReport({
            assignmentId: record.id, answer: run.answer ?? '', succeeded: run.succeeded,
            ...(run.changedFiles ? { changedFiles: run.changedFiles } : {}),
            ...(run.observedChecks ? { observedChecks: run.observedChecks } : {}),
            ...(run.evidenceRefs ? { evidenceRefs: run.evidenceRefs } : {}),
          });
          move('REPORT_READY', { report }, { evidenceRefs: report.evidenceRefs });
          break;
        }

        case 'REPORT_READY': {
          if (deps.parentStopped?.()) return outcome(cancelAssignment(ctx, record, 'the delegating task was stopped'));
          move('UNDER_REVIEW');
          break;
        }

        case 'UNDER_REVIEW': {
          // After a restart the result is not in memory; the child is finished,
          // so reading it back is immediate.
          run ??= await deps.waitForChild(childId);
          const verdict = reviewChildWork({
            assignment: record, run,
            ...(deps.verifyCheck ? { verifyCheck: (check: string) => deps.verifyCheck!(check, record) } : {}),
          });
          if (verdict.accepted) {
            move('ACCEPTED', {}, { evidenceRefs: verdict.evidenceRefs });
            break;
          }
          // Refused. The child keeps its workspace and its context; what it needs
          // is to know exactly what failed.
          const feedback = buildParentFeedback({
            assignmentId: record.id, revision: record.revision + 1, failedChecks: verdict.failedChecks,
            guidance: ['Run each failed check yourself and put its result in your report — the parent accepts only on evidence.'],
          });
          const history = [...record.feedbackHistory, ...(record.feedback ? [record.feedback] : [])].slice(-5);
          move('FEEDBACK_REQUIRED', { feedback, feedbackHistory: history }, {
            reason: `parent acceptance failed: ${verdict.failedChecks.map((failed) => failed.check).join('; ')}`,
            evidenceRefs: verdict.failedChecks.flatMap((failed) => failed.evidenceRefs),
          });
          break;
        }

        case 'ACCEPTED':
        case 'MERGING': {
          let merged = await serialMerge(ctx, record.id);
          record = ledger.get(record.id) ?? record;

          // A conflict is not a failure of the work, and the parent is the wrong one
          // to settle it: it would read two diffs it did not write, for code it does
          // not own. The child wrote one side and knows why. So — once — the
          // conflict goes back to the same child, in its own workspace, with both
          // sides in front of it. If that is not possible or not worth it, the
          // assignment simply stays INTEGRATION_BLOCKED.
          if (
            merged === 'INTEGRATION_BLOCKED' && deps.prepareConflictRework
            && conflictReworks < MAX_CONFLICT_REWORKS && !deps.parentStopped?.()
          ) {
            const prepared = deps.prepareConflictRework(record);
            if (prepared && prepared.conflicts.length === 0) {
              merged = await serialMerge(ctx, record.id); // the rebase was clean: try again
              record = ledger.get(record.id) ?? record;
            } else if (prepared) {
              const files = prepared.conflicts.slice(0, 10).join(', ');
              const conflictFeedback = buildParentFeedback({
                assignmentId: record.id, revision: record.revision + 1,
                failedChecks: [{
                  check: CONFLICT_CHECK,
                  observed: `it conflicts with work already merged, in: ${files}. The conflict markers are in your workspace.`,
                  expected: 'both your change and the work already merged, kept',
                  evidenceRefs: [],
                }],
                guidance: ['Open each listed file, resolve every <<<<<<< / ======= / >>>>>>> marker keeping both intents, re-run the checks, then report again.'],
              });
              run ??= await deps.waitForChild(childId);
              const decision = await recoveryDecision(
                ctx, { assignment: record, feedback: conflictFeedback, reworks, run }, reassignments);
              if (decision.action === 'rework' && !deps.parentStopped?.()) {
                const history = [...record.feedbackHistory, ...(record.feedback ? [record.feedback] : [])].slice(-5);
                move('FEEDBACK_REQUIRED', { feedback: conflictFeedback, feedbackHistory: history }, {
                  reason: `merge conflict in: ${files}`,
                });
                record = requestRework(ctx, record.id, piece.baseGoal);
                reworks++;
                conflictReworks++;
                run = undefined;
                break;
              }
            }
          }
          if (record.status === 'REWORKING') break; // sent back above
          return { childId, assignmentId: record.id, status: merged };
        }

        case 'FEEDBACK_REQUIRED': {
          const feedback = record.feedback;
          if (!feedback) return outcome(escalateAssignment(ctx, record, 'the assignment needs a decision but recorded no feedback'));
          run ??= await deps.waitForChild(childId);
          const decision = await recoveryDecision(ctx, { assignment: record, feedback, reworks, run }, reassignments);
          if (decision.action === 'escalate') return outcome(escalateAssignment(ctx, record, decision.reason));
          if (decision.action === 'cancel') return outcome(cancelAssignment(ctx, record, decision.reason));
          if (deps.parentStopped?.()) return outcome(cancelAssignment(ctx, record, 'the delegating task was stopped'));

          if (decision.action === 'reassign') {
            try {
              const next = requestReassignment(ctx, record.id, decision, piece);
              record = next.record;
              childId = next.childId;
              reworks = 0;
              conflictReworks = 0;
              reassignments++;
              run = undefined;
            } catch (err) {
              if (!(err instanceof ReassignmentRefused)) throw err;
              return outcome(escalateAssignment(ctx, record, err.message));
            }
            break;
          }

          record = requestRework(ctx, record.id, piece.baseGoal);
          reworks++;
          run = undefined;
          break;
        }

        // MERGED, INTEGRATION_BLOCKED, ESCALATED, CANCELLED, REASSIGNED: settled,
        // or waiting on a decision that is not this loop's to make.
        default:
          return outcome(record);
      }
    }
  } catch (err) {
    // Something else moved this assignment: another driver, or a recovery pass.
    // Acting on a state this one has not seen is how a merge happens twice.
    if (err instanceof DelegationStaleError) return outcome(ledger.get(record.id) ?? record);
    throw err;
  }
}

/** Assignment statuses in which work is still owed. Anything else has settled or
 *  is waiting on a decision. */
const IN_FLIGHT: ReadonlySet<DelegationStatus> = new Set([
  'ASSIGNED', 'WORKING', 'REWORKING', 'BLOCKED', 'REPORT_READY', 'UNDER_REVIEW',
  'FEEDBACK_REQUIRED', 'ACCEPTED', 'MERGING',
]);

/** The live assignment for each piece: the one that is not a superseded owner. */
function activeByPiece(records: readonly DelegationRecord[]): Map<number, DelegationRecord> {
  const active = new Map<number, DelegationRecord>();
  for (const record of records) {
    if (record.piece === undefined || record.status === 'REASSIGNED') continue;
    active.set(record.piece, record); // oldest first, so a successor replaces its predecessor
  }
  return active;
}

/** Whether a restarted parent has anything to resume.
 *
 *  True when an assignment is still in flight, or when a piece never got one and
 *  everything it waits for has merged (so it can start now). False when every
 *  piece has settled — merged, cancelled, escalated or waiting on a decision — in
 *  which case the old rule stands and the parent does not split a second time. */
export function needsResume(
  records: readonly DelegationRecord[], after: readonly (readonly number[])[], pieceCount: number,
): boolean {
  const active = activeByPiece(records);
  if ([...active.values()].some((record) => IN_FLIGHT.has(record.status))) return true;
  for (let index = 0; index < pieceCount; index++) {
    if (active.has(index)) continue;
    const prerequisites = after[index] ?? [];
    if (prerequisites.every((dep) => active.get(dep)?.status === 'MERGED')) return true;
  }
  return false;
}

/** Hands each subgoal to its own child and runs them on the schedule the work
 *  graph allows.
 *
 *  Each piece is a durable assignment. The parent assigns it, the child owns
 *  executing it, and when the child reports, the *parent* reviews the candidate
 *  and decides whether to take responsibility for it. Only accepted work merges.
 *  Refused work goes back to the same child, in its same workspace, with
 *  structured feedback; a different child takes over only through an explicit,
 *  recorded reassignment decision.
 *
 *  Previously a failed piece was handed to a fresh sibling and a finished
 *  child's fork was integrated whether or not anyone had accepted it. Both are
 *  gone: one threw away the failed attempt's context and workspace, the other
 *  let unreviewed work into the tree the rest of the run sees.
 *
 *  Siblings inside a group run concurrently; groups run in order. */
export async function delegateToChildren(
  input: DelegateInput,
  deps: DelegateChildDeps,
): Promise<ExecuteStepResult> {
  // No usable split means no delegation. Handing the child the parent's own
  // goal is the clone case, and it is never the right answer: the parent should
  // do the work itself instead.
  if ((input.existingChildren ?? 0) > 0 && !input.resume) {
    return {
      succeeded: false,
      notDelegatable: true,
      message: `This work was already split across ${input.existingChildren} agents. Finishing it directly rather than splitting it a second time.`,
      events: [],
      usage: { ...ZERO_USAGE },
    };
  }

  const subgoals = (input.subgoals ?? []).filter((goal) => goal.trim().length > 0);
  if (subgoals.length === 0) {
    return {
      succeeded: false,
      // Not a failure to retry: retrying re-runs the planner and reaches the
      // same conclusion, at the cost of another sandbox each time. The machine
      // reads this flag and does the work itself instead.
      notDelegatable: true,
      message: 'This goal did not split into independent pieces, so the agent is doing it directly.',
      events: [],
      usage: { ...ZERO_USAGE },
    };
  }

  const nodes = workstreamNodesFor(subgoals, input.after);

  // Checked before authority is allocated and before any child exists, because
  // every way a plan is bad is cheap to detect now and expensive to discover
  // after k sandboxes have started. An invalid plan is not a failed
  // delegation — it is a goal to do directly.
  // Not on a resume: the plan was already validated and funded, and a restart
  // must never be able to veto work that is in flight.
  if (input.authority && !input.resume) {
    const validation = validateDelegationPlan(
      { goal: input.goal, authority: input.authority },
      {
        subgoals: subgoals.map((goal, index) => ({
          id: String(index), goal,
          writePaths: nodes[index].writePaths,
          dependencies: nodes[index].inputDependencies,
        })),
      },
    );
    deps.recordPlanValidation?.(validation);
    if (!validation.valid) {
      return {
        succeeded: false,
        notDelegatable: true,
        message: `The split this goal produced is not worth funding (${validation.reasons.join(', ')}), so the agent is doing it directly.`,
        events: [],
        usage: { ...ZERO_USAGE },
      };
    }
  }

  const plan = planWorkstreams({ nodes });
  // Siblings inside a group run concurrently below, so a group wider than one
  // *is* the parallel topology rather than a preference for it.
  const topology = delegationTopology(plan, ['parallelize']);
  deps.recordSchedule?.({ plan, topology, cancelled: [] });

  const ctx: AssignmentContext = {
    deps, ledger: deps.ledger ?? createMemoryLedger(),
    parentId: input.parentId, siblingCount: subgoals.length,
    ...(input.approvedBudgetUsd === undefined ? {} : { approvedBudgetUsd: input.approvedBudgetUsd }),
    mergeChain: Promise.resolve(),
  };

  // A restarted parent finds its earlier assignments here. Empty on a first run,
  // so the loop below is the same code either way: for each piece, use the
  // assignment that exists or make the one that does not.
  const existing = input.resume ? activeByPiece(ctx.ledger.listForParent(input.parentId)) : new Map<number, DelegationRecord>();

  const results: { childId: string; goal: string; status: DelegationStatus }[] = [];
  const cancelled: { goal: string; reason: string }[] = [];
  // Everything downstream of a piece that was not merged. Recomputed as pieces
  // settle rather than once at the end, because the point is to not pay for the
  // child at all.
  const doomed = new Map<string, string>();
  // Which child and assignment finally owned each piece, so a dependent can be
  // handed its report and record who it waited for.
  const doneBy = new Map<string, string>();
  const assignmentOf = new Map<string, string>();

  for (const group of plan.parallelGroups) {
    if (deps.parentStopped?.()) {
      for (const id of group) cancelled.push({ goal: subgoals[Number(id)], reason: 'the task was stopped' });
      continue;
    }
    const runnable = group.filter((id) => {
      const reason = doomed.get(id);
      if (!reason) return true;
      cancelled.push({ goal: subgoals[Number(id)], reason });
      return false;
    });
    if (runnable.length === 0) continue;

    // Siblings in one group run concurrently — waiting for each in turn would
    // make a fan-out take as long as a chain, which is the thing it exists to
    // avoid. Siblings in *different* groups do not, because the plan put them
    // apart for a reason.
    const started = runnable.map((id) => {
      const index = Number(id);
      const prerequisites = nodes[index].inputDependencies;
      const goal = prerequisites.length === 0 ? subgoals[index] : withPrerequisites(
        subgoals[index],
        prerequisites.map((dep) => ({
          goal: subgoals[Number(dep)],
          findings: doneBy.has(dep) ? deps.getFindings?.(doneBy.get(dep)!) ?? '' : '',
        })),
      );
      const piece: Piece = {
        index, baseGoal: subgoals[index], goal,
        contract: {
          // A child's own DoD, when the plan gave one; otherwise the minimal
          // contract its subgoal states.
          definitionOfDone: input.definitionOfDoneBySubgoal?.[index]?.length
            ? input.definitionOfDoneBySubgoal[index] : [subgoals[index]],
          acceptanceChecks: [...new Set([
            ...(input.acceptanceChecks ?? []), ...(input.acceptanceChecksBySubgoal?.[index] ?? []),
          ])],
          ...(input.writeScopeBySubgoal?.[index] ? { writeScope: input.writeScopeBySubgoal[index] } : {}),
        },
        dependencies: prerequisites.flatMap((dep) => assignmentOf.get(dep) ?? []),
      };
      // Already assigned before a restart: that assignment is this piece's, and
      // it is picked up where its record says it is. Never assigned twice.
      const prior = existing.get(index);
      if (prior) return { id, piece, record: prior, childId: prior.childId };
      return { id, piece, ...assignPiece(ctx, piece) };
    });

    // Each child is driven from its own state to its own end: accepted and
    // merged, or sent back to the same child, or escalated. A slow sibling never
    // waits behind another's rework, and a failed one never disturbs an
    // accepted one.
    const settled = await Promise.all(started.map(async (child) => ({
      id: child.id, ...(await driveAssignment(ctx, child.piece, { record: child.record, childId: child.childId })),
    })));

    for (const child of settled) {
      doneBy.set(child.id, child.childId);
      assignmentOf.set(child.id, child.assignmentId);
      results.push({ childId: child.childId, goal: subgoals[Number(child.id)], status: child.status });
      if (child.status === 'MERGED') continue;
      const why = child.status === 'CANCELLED' ? 'stopped piece'
        : child.status === 'INTEGRATION_BLOCKED' ? 'piece that could not be merged' : 'failed piece';
      for (const dependent of dependentsOf(nodes, child.id)) {
        if (!doomed.has(dependent)) {
          doomed.set(dependent, `depends on the ${why}: ${subgoals[Number(child.id)]}`);
        }
      }
    }
  }

  if (cancelled.length > 0) deps.recordSchedule?.({ plan, topology, cancelled });

  // A merge that conflicted is a different situation from work that never
  // passed review: the work was right, and redoing it would not help. It is
  // named separately so nobody reads a conflict as an implementation failure.
  const conflicted = results.filter((result) => result.status === 'INTEGRATION_BLOCKED');
  const failed = results.filter((result) => result.status !== 'MERGED' && result.status !== 'INTEGRATION_BLOCKED');
  const notes = cancelled.length > 0
    ? ` ${cancelled.length} further ${cancelled.length === 1 ? 'piece was' : 'pieces were'} not started because what ${cancelled.length === 1 ? 'it' : 'they'} depended on was not merged.`
    : '';
  const clean = failed.length === 0 && conflicted.length === 0 && cancelled.length === 0;
  const problems = [
    failed.length > 0
      ? `${failed.length} of ${results.length} delegated pieces did not succeed: ${failed.map((f) => f.goal).join('; ')}.`
      : '',
    conflicted.length > 0
      ? `${conflicted.length} of ${results.length} delegated pieces were accepted but could not be merged (integration blocked): ${conflicted.map((f) => f.goal).join('; ')}.`
      : '',
  ].filter(Boolean).join(' ');
  return {
    succeeded: clean,
    message: clean
      ? `All ${results.length} delegated pieces completed`
      : `${problems}${notes}`.trim(),
    events: [],
    usage: { ...ZERO_USAGE },
  };
}
