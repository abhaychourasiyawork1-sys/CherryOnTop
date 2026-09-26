import type { ExecuteStepResult } from '../execution/execute-step.js';
import { ZERO_USAGE } from '../execution/tokens.js';
import type { Authority } from '../schemas/node-contract.js';
import { effectiveAuthority } from '../engines/authority.js';
import { MIN_AGENT_BUDGET_USD } from '../engines/decide-execution.js';
import { planWorkstreams, dependentsOf, type WorkstreamNode, type WorkstreamPlan } from '../execution/workstreams.js';
import { extractAnchors } from '../efficiency/task-economics.js';
import { assessDecomposition } from '../intelligence/decompose.js';
import { validateDelegationPlan, type DelegationValidationResult } from '../decision/delegation-validator.js';

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
  /** The parent's own authority, so the plan can be checked against it before
   *  any child exists. Absent means the structural checks that need it are
   *  skipped — every pre-validator caller behaves exactly as before. */
  authority?: Authority;
  /** How many children this node already created. Delegation is a one-time act:
   *  if a fan-out came back with any piece unfinished, the machine's retry used
   *  to re-plan and create a *second* full set of children — duplicating the
   *  pieces that had already succeeded and spending the quota twice. */
  existingChildren?: number;
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

  return {
    ...authority,
    // Spawn authority a child could never afford to use only sends it straight
    // to ESCALATE, asking a human to approve the same delegation one generation
    // down. It needs enough for itself and at least one child.
    spawn_children: authority.spawn_children && authority.budget_usd >= MIN_AGENT_BUDGET_USD * 2,
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

export interface DelegateChildDeps {
  /** Records what the parent addressed to this child. Optional: a deployment
   *  with no envelope store dispatches children exactly as before. */
  recordEnvelope?: (childId: string, goal: string, budgetUsd: number) => void;
  /** `siblingCount` rather than a budget: what a child may hold is derived from
   *  its parent and how many ways the work was split, so no caller is in a
   *  position to decide it. */
  createChildNode: (parentId: string, goal: string, siblingCount: number, approvedBudgetUsd?: number) => string;
  recordCommitment: (childId: string, goal: string) => void;
  startChild: (childId: string, goal: string) => void;
  waitForChild: (childId: string) => Promise<{ succeeded: boolean }>;
  /** What the work graph said and what it cost. Optional: a deployment with no
   *  telemetry sink schedules exactly the same, it just says nothing about it. */
  recordSchedule?: (schedule: DelegationSchedule) => void;
  /** Why a plan was funded or refused. Optional, for the same reason. */
  recordPlanValidation?: (validation: DelegationValidationResult) => void;
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
 *  Read-only subgoals ("review X", "audit Y") contribute their anchors as
 *  *information* dependencies instead — two branches reading one module is not
 *  a conflict, it is the duplication `sharedEvidenceIds` exists to name.
 *
 *  ponytail: anchors are a heuristic for write paths; a planner that emitted
 *  explicit file claims per subgoal would replace this whole function. */
export function workstreamNodesFor(subgoals: string[]): WorkstreamNode[] {
  return subgoals.map((goal, index) => {
    const anchors = extractAnchors(goal);
    const readOnly = assessDecomposition(goal).explanationOnly;
    return {
      id: String(index),
      inputDependencies: [],
      informationDependencies: anchors,
      outputDependencies: [],
      validationDependencies: [],
      writePaths: readOnly ? [] : anchors,
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

/** Hands each subgoal to its own child and runs them on the schedule the work
 *  graph allows.
 *
 *  Previously this created one child carrying the parent's goal verbatim, so a
 *  delegating organization was a chain of identical clones, each re-deciding the
 *  same question one generation down. With a real split, siblings work in
 *  parallel on different things — which is the only version of this that is
 *  worth the coordination cost the economics engine charges for it.
 *
 *  What changed after that: the fan-out was an unconditional `Promise.all` over
 *  every planned child, which starts two children writing the same file at the
 *  same moment and keeps paying for children whose prerequisite has already
 *  failed. Groups run in order; within a group, concurrently. */
export async function delegateToChildren(
  input: DelegateInput,
  deps: DelegateChildDeps,
): Promise<ExecuteStepResult> {
  // No usable split means no delegation. Handing the child the parent's own
  // goal is the clone case, and it is never the right answer: the parent should
  // do the work itself instead.
  if ((input.existingChildren ?? 0) > 0) {
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

  const nodes = workstreamNodesFor(subgoals);

  // Checked before authority is allocated and before any child exists, because
  // every way a plan is bad is cheap to detect now and expensive to discover
  // after k sandboxes have started. An invalid plan is not a failed
  // delegation — it is a goal to do directly.
  if (input.authority) {
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

  const results: { childId: string; goal: string; succeeded: boolean }[] = [];
  const failedIds: string[] = [];
  const cancelled: { goal: string; reason: string }[] = [];
  // Everything downstream of something that already failed. Recomputed as
  // failures land rather than once at the end, because the point is to not pay
  // for the child at all.
  const doomed = new Map<string, string>();

  for (const group of plan.parallelGroups) {
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
      const goal = subgoals[Number(id)];
      const childId = deps.createChildNode(input.parentId, goal, subgoals.length, input.approvedBudgetUsd);
      deps.recordCommitment(childId, goal);
      // Before the child starts, not after: the envelope is what its first
      // dispatch reads, and a child that started first would read nothing.
      deps.recordEnvelope?.(childId, goal, input.approvedBudgetUsd ?? 0);
      deps.startChild(childId, goal);
      return { id, childId, goal };
    });

    const settled = await Promise.all(
      started.map(async (child) => ({ ...child, ...(await deps.waitForChild(child.childId)) })),
    );

    for (const child of settled) {
      results.push({ childId: child.childId, goal: child.goal, succeeded: child.succeeded });
      if (child.succeeded) continue;
      failedIds.push(child.id);
      for (const dependent of dependentsOf(nodes, child.id)) {
        if (!doomed.has(dependent)) doomed.set(dependent, `depends on the failed piece: ${child.goal}`);
      }
    }
  }

  if (cancelled.length > 0) deps.recordSchedule?.({ plan, topology, cancelled });

  const failed = results.filter((result) => !result.succeeded);
  const notes = cancelled.length > 0
    ? ` ${cancelled.length} further ${cancelled.length === 1 ? 'piece was' : 'pieces were'} not started because what ${cancelled.length === 1 ? 'it' : 'they'} depended on failed.`
    : '';
  return {
    succeeded: failed.length === 0 && cancelled.length === 0,
    message: failed.length === 0 && cancelled.length === 0
      ? `All ${results.length} delegated pieces completed`
      : `${failed.length} of ${results.length} delegated pieces did not succeed: ${failed.map((f) => f.goal).join('; ')}.${notes}`,
    events: [],
    usage: { ...ZERO_USAGE },
  };
}
