/** Is this plan worth creating children for?
 *
 *  Delegation is the most expensive thing the runtime does: a planning
 *  dispatch, k sandboxes, and a synthesis dispatch. All of that is spent before
 *  anyone finds out whether the plan was any good — and the ways a plan is bad
 *  are cheap to detect and catastrophic to discover late:
 *
 *   - **clones.** Two subgoals that are the same job. Paid for twice, merged
 *     into a conflict.
 *   - **holes.** A parent goal naming three deliverables and a plan covering
 *     two. The third silently never happens and the run reports success.
 *   - **escapes.** A child scoped to write where its parent may not.
 *   - **tangles.** A dependency graph that cannot be scheduled, so the
 *     scheduler falls back to running everything one at a time and the fan-out
 *     bought nothing.
 *
 *  So the plan is checked *before* authority is allocated and before any child
 *  exists. An invalid plan is not a failure: the parent does the work itself,
 *  or plans again at the next safe boundary.
 *
 *  This answers "is the plan valid?" only. "In what order may valid work run?"
 *  is `execution/workstreams.ts`, and is reused here rather than reimplemented —
 *  a second scheduler would be a second answer to the same question.
 *
 *  Deterministic and total: no model, no clock, no I/O. V1 is structural on
 *  purpose; an LLM reviewer here would be a second planning dispatch wearing a
 *  review's clothes. */
import { planWorkstreams, type WorkstreamNode } from '../execution/workstreams.js';
import { isReadOnly } from '../engines/enforce-tools.js';
import type { Authority } from '../schemas/node-contract.js';

export interface DelegationSubgoal {
  id: string;
  goal: string;
  writePaths: string[];
  dependencies: string[];
}

export interface DelegationPlan {
  subgoals: DelegationSubgoal[];
}

export interface DelegationValidationResult {
  valid: boolean;
  /** How much of the parent's explicitly named deliverables the plan covers,
   *  on [0,1]. `1` when the parent named none — a goal with no enumerated
   *  parts cannot have a hole in its enumeration. */
  coverage: number;
  /** How different the subgoals are from each other, on [0,1]. */
  distinctness: number;
  scopeSafe: boolean;
  dependencySafe: boolean;
  conflictFree: boolean;
  reasons: string[];
}

/** Anything short of this and two subgoals are the same job described twice. */
const CLONE_SIMILARITY = 0.8;
/** A parent that named its parts wants all of them. */
const MIN_COVERAGE = 0.999;

/** The parent's parts, when it enumerated any.
 *
 *  Only *explicit* separators count. Inferring deliverables from prose would
 *  make coverage a guess, and a guess that can reject a plan is a guess that
 *  stops work for no reason. Same vocabulary `decompose.ts` counts items with. */
const ITEM_SEPARATOR = /(?:\band then\b|\balso\b|\bas well as\b|\bplus\b|;|\n\s*[-*•]\s|\n\s*\d+[.)]\s)/i;

export function parentDeliverables(goal: string): string[] {
  const parts = goal.split(ITEM_SEPARATOR).map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [];
}

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'for', 'on', 'with', 'this', 'that', 'it']);

function words(text: string): Set<string> {
  return new Set(
    text.toLowerCase().match(/[a-z0-9_./-]{2,}/g)?.filter((word) => !STOPWORDS.has(word)) ?? [],
  );
}

/** Jaccard. Symmetric, bounded, and cheap — the properties that matter for a
 *  check whose job is to be run on every plan. */
function similarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  // No comparable words is *no evidence*, not perfect agreement. Reading it as
  // a clone would refuse to fund a plan on the strength of having nothing to
  // say about it, and refusing on no evidence is the worse error here.
  if (left.size === 0 || right.size === 0) return 0;
  const shared = [...left].filter((word) => right.has(word)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : shared / union;
}

function workstreamNodes(plan: DelegationPlan): WorkstreamNode[] {
  return plan.subgoals.map((subgoal) => ({
    id: subgoal.id,
    inputDependencies: subgoal.dependencies,
    informationDependencies: [],
    outputDependencies: [],
    validationDependencies: [],
    writePaths: subgoal.writePaths,
  }));
}

export interface DelegationValidationInput {
  goal: string;
  authority: Authority;
  /** Paths the parent itself is scoped to. Absent means the parent is not
   *  path-scoped, and only its tool grant constrains its children. */
  writeScope?: string[];
}

/** The whole check. Every failure names itself in `reasons`, because a plan
 *  rejected without a reason code is a fan-out that silently stopped
 *  happening. */
export function validateDelegationPlan(
  parent: DelegationValidationInput,
  plan: DelegationPlan,
): DelegationValidationResult {
  const reasons: string[] = [];
  const subgoals = plan.subgoals ?? [];

  if (subgoals.length === 0) {
    return {
      valid: false, coverage: 0, distinctness: 0,
      scopeSafe: true, dependencySafe: true, conflictFree: true,
      reasons: ['empty_plan'],
    };
  }
  if (subgoals.length === 1) reasons.push('single_child_plan_is_not_a_split');

  // --- distinctness ------------------------------------------------------
  let worstPair = 0;
  for (let i = 0; i < subgoals.length; i++) {
    for (let j = i + 1; j < subgoals.length; j++) {
      const score = similarity(subgoals[i].goal, subgoals[j].goal);
      worstPair = Math.max(worstPair, score);
      if (score >= CLONE_SIMILARITY) {
        reasons.push('duplicate_or_clone_subgoal');
      }
    }
  }
  const distinctness = 1 - worstPair;

  // --- coverage ----------------------------------------------------------
  const deliverables = parentDeliverables(parent.goal);
  const covered = deliverables.filter((part) =>
    subgoals.some((subgoal) => similarity(part, subgoal.goal) >= 0.25));
  const coverage = deliverables.length === 0 ? 1 : covered.length / deliverables.length;
  if (coverage < MIN_COVERAGE) reasons.push('incomplete_coverage');

  // --- scope containment -------------------------------------------------
  const parentReadOnly = isReadOnly(parent.authority);
  const allWrites = subgoals.flatMap((subgoal) => subgoal.writePaths);
  let scopeSafe = true;
  if (parentReadOnly && allWrites.length > 0) {
    scopeSafe = false;
    reasons.push('child_writes_beyond_read_only_parent');
  }
  if (parent.writeScope && parent.writeScope.length > 0) {
    const escaping = allWrites.filter((path) =>
      !parent.writeScope!.some((scope) => path === scope || path.startsWith(scope.endsWith('/') ? scope : `${scope}/`)));
    if (escaping.length > 0) {
      scopeSafe = false;
      reasons.push(`child_scope_exceeds_parent:${[...new Set(escaping)].sort().join(',')}`);
    }
  }
  if (!parent.authority.spawn_children) {
    scopeSafe = false;
    reasons.push('parent_may_not_spawn_children');
  }
  if (parent.authority.max_child_count < subgoals.length) {
    scopeSafe = false;
    reasons.push(`plan_exceeds_agent_allowance:${subgoals.length}>${parent.authority.max_child_count}`);
  }

  // --- dependency correctness -------------------------------------------
  const known = new Set(subgoals.map((subgoal) => subgoal.id));
  let dependencySafe = true;
  if (known.size !== subgoals.length) {
    dependencySafe = false;
    reasons.push('duplicate_subgoal_id');
  }
  for (const subgoal of subgoals) {
    for (const dependency of subgoal.dependencies ?? []) {
      if (dependency === subgoal.id) {
        dependencySafe = false;
        reasons.push(`self_dependency:${subgoal.id}`);
      } else if (!known.has(dependency)) {
        dependencySafe = false;
        reasons.push(`unknown_dependency:${subgoal.id}->${dependency}`);
      }
    }
  }

  // The scheduler is the authority on whether this graph can run at all. It
  // reports a cycle rather than refusing to plan, so the cycle is read back out
  // of its reasons instead of being detected a second time here.
  const schedule = planWorkstreams({ nodes: workstreamNodes(plan) });
  if (schedule.serializationReasons.some((reason) => reason.startsWith('dependency_cycle'))) {
    dependencySafe = false;
    reasons.push('dependency_cycle');
  }

  // --- write conflicts ---------------------------------------------------
  // An overlap is only fatal when it cannot be *serialized*. Two subgoals that
  // touch one file are fine if the scheduler can put them in different groups;
  // they are a corrupted worktree if it cannot.
  const overlaps = schedule.serializationReasons.filter((reason) => reason.startsWith('write_conflict:'));
  const conflictFree = overlaps.length === 0;
  if (!conflictFree) {
    reasons.push(dependencySafe ? 'write_overlap_serialized' : 'unserializable_write_conflict');
  }

  const valid = distinctness > 1 - CLONE_SIMILARITY
    && coverage >= MIN_COVERAGE
    && scopeSafe
    && dependencySafe
    && subgoals.length > 1;

  reasons.push(valid ? 'plan_valid' : 'plan_rejected');
  return {
    valid,
    coverage: Number(coverage.toFixed(4)),
    distinctness: Number(distinctness.toFixed(4)),
    scopeSafe,
    dependencySafe,
    conflictFree,
    reasons: [...new Set(reasons)],
  };
}
