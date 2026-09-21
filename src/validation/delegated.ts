/** Whether a fan-out actually produced the parent's outcome.
 *
 *  A delegating parent has the easiest false success in the system available to
 *  it: every child reported done, so the parent reports done. That is a tally,
 *  not a verdict. Four things it misses, each of which has a different fix:
 *
 *   - **a child that finished without validating.** `EXECUTION_FINISHED` is not
 *     `TASK_SUCCESS` one level down either.
 *   - **a child that succeeded outside its authority.** Green and out of scope
 *     is not green; it is a breach that happens to have compiled.
 *   - **a child that ran before its prerequisite.** Its result is about a tree
 *     that no longer exists.
 *   - **successful siblings thrown away** because one branch failed. Two
 *     branches that merely needed to understand the same module are unrelated,
 *     and discarding the good one is the most expensive way to handle a partial
 *     failure.
 *
 *  So aggregation reports *which* children failed and *which* dependents are
 *  blocked, separately, and says nothing about the ones that are fine. That
 *  separation is what lets recovery reconsider only the failed work.
 *
 *  This grants no authority and writes no prose: it does not synthesize child
 *  answers, it decides whether there is anything worth synthesizing.
 *  Deterministic and total. */
import { validate, type ValidationEvidence, type ValidationResult } from './engine.js';
import { dependentsOf, type WorkstreamNode } from '../execution/workstreams.js';
import type { ValidationContract } from './contract.js';

export interface DelegatedChildOutcome {
  id: string;
  /** What the child's own runtime reported. The claim. */
  succeeded: boolean;
  /** What the child's own validation concluded. The check. */
  validation: ValidationResult;
  changedPaths: string[];
  /** Whether everything it did was inside the authority it was granted. */
  authorityCompliant: boolean;
  /** Whether the work it depended on had finished before it ran. */
  dependenciesSatisfied: boolean;
  /** Whether the parent's outcome needs this child at all. A child whose piece
   *  was optional failing does not fail the parent. Defaults to required,
   *  because assuming otherwise is how a hole in the work becomes a success. */
  required?: boolean;
}

export interface DelegatedValidationInput {
  parentRequiredChecks: string[];
  children: DelegatedChildOutcome[];
  /** What the merged result looks like from the parent's side. */
  mergedOutcome: ValidationEvidence;
  /** The graph the children ran on, so blocked dependents can be named rather
   *  than guessed at. Absent means no ordering was claimed. */
  graph?: WorkstreamNode[];
  /** The contract the *parent* must clear. Absent falls back to the ladder's
   *  default. */
  contract?: ValidationContract;
}

export interface DelegatedValidationResult {
  passed: boolean;
  /** Children whose own evidence does not support their claim, or who breached
   *  scope or ordering. */
  childFailures: string[];
  /** Work that could not proceed because something it depended on failed. Not
   *  a failure of its own — a reason to reconsider it after the prerequisite
   *  recovers. */
  blockedDependents: string[];
  /** Children whose work stands regardless of what happened elsewhere. Named
   *  explicitly so a recovery cannot quietly discard them. */
  retainedChildren: string[];
  /** The parent's own verdict on the merged outcome. */
  parentValidation: ValidationResult;
  reasons: string[];
}

/** Whether one child's result may be believed. */
function childHolds(child: DelegatedChildOutcome): { ok: boolean; reason?: string } {
  if (!child.authorityCompliant) return { ok: false, reason: `authority_violation:${child.id}` };
  if (!child.dependenciesSatisfied) return { ok: false, reason: `ran_before_prerequisite:${child.id}` };
  if (!child.succeeded) return { ok: false, reason: `child_execution_failed:${child.id}` };
  // The one that matters most and is easiest to skip: a child that claimed
  // success and could not back it.
  if (!child.validation.passed) return { ok: false, reason: `child_validation_failed:${child.id}` };
  return { ok: true };
}

export function validateDelegatedOutcome(input: DelegatedValidationInput): DelegatedValidationResult {
  const reasons: string[] = [];
  const children = input.children ?? [];
  const childFailures: string[] = [];
  const retainedChildren: string[] = [];

  for (const child of children) {
    const verdict = childHolds(child);
    if (verdict.ok) {
      retainedChildren.push(child.id);
      continue;
    }
    childFailures.push(child.id);
    reasons.push(verdict.reason!);
  }

  // What could not proceed, from the ordering graph rather than from a guess.
  // Information dependencies contribute nothing here, by construction: two
  // branches reading the same module are not each other's prerequisites.
  const blocked = new Set<string>();
  if (input.graph) {
    for (const failed of childFailures) {
      for (const dependent of dependentsOf(input.graph, failed)) {
        if (!childFailures.includes(dependent)) blocked.add(dependent);
      }
    }
  }
  const blockedDependents = [...blocked].sort();
  // A blocked child is not retained work: it never ran on the tree that exists.
  const retained = retainedChildren.filter((id) => !blocked.has(id)).sort();
  if (retained.length > 0) reasons.push(`retained_siblings:${retained.length}`);
  if (blockedDependents.length > 0) reasons.push(`blocked_dependents:${blockedDependents.length}`);

  // The parent's own evidence still goes through the same ladder. A parent
  // cannot inherit success from its children any more than it can from its own
  // exit code.
  const parentValidation = validate({
    evidence: {
      ...input.mergedOutcome,
      requiredChecks: input.mergedOutcome.requiredChecks,
    },
    ...(input.contract ? { contract: input.contract } : {}),
  });

  const requiredFailed = children.some((child) =>
    child.required !== false && childFailures.includes(child.id));
  if (requiredFailed) reasons.push('required_child_failed');

  const unmetParentChecks = input.parentRequiredChecks.filter((check) =>
    !input.mergedOutcome.requiredChecks.some((item) => item.text === check && item.met));
  if (unmetParentChecks.length > 0) reasons.push(`parent_required_checks_unmet:${unmetParentChecks.length}`);

  if (children.length === 0) reasons.push('no_children_to_aggregate');

  const passed = children.length > 0
    && !requiredFailed
    && blockedDependents.length === 0
    && unmetParentChecks.length === 0
    && parentValidation.passed;

  reasons.push(passed ? 'delegated_outcome_validated' : 'delegated_outcome_rejected');
  return {
    passed,
    childFailures: childFailures.sort(),
    blockedDependents,
    retainedChildren: retained,
    parentValidation,
    reasons: [...new Set(reasons)],
  };
}
