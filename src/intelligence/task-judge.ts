/** Whether this task is worth planning, and what kind of task it is.
 *
 *  Planning costs a whole sandbox. The only thing it can buy is a split, so on
 *  a goal that does not split it buys nothing — and the measured cost of
 *  finding that out the expensive way was a planner Job plus five children on a
 *  goal with one seam and no second workstream.
 *
 *  This is the cheap judgement that runs first: deterministic, model-free, and
 *  built on `assessDecomposition` rather than beside it. It does not decide
 *  *how* to do the work — that is the execution template — only whether
 *  deciding is worth paying for.
 */
import { assessDecomposition, type Decomposition } from './decompose.js';

/** What kind of work this is. Used to pick an execution template, and nothing
 *  else — in particular not to pick a model, which routes on complexity. */
export type TaskClass =
  | 'trivial_edit'
  | 'investigation'
  | 'implementation'
  | 'multi_workstream'
  | 'documentation'
  | 'test_authoring'
  | 'debugging';

export interface TaskVerdict {
  taskClass: TaskClass;
  /** Skip planning and every gate that exists to decide how to plan. */
  direct: boolean;
  /** Worth paying a sandbox to ask how this splits. */
  worthPlanning: boolean;
  /** True when a cached plan can answer for free, so the benefit calculation
   *  does not apply — a free answer is worth having whatever it would have cost
   *  to compute. */
  planCacheEligible: boolean;
  reason: string;
  decomposition: Decomposition;
}

/** Nothing about the goal suggests it is more than one edit. */
const TRIVIAL = /\b(typo|rename|bump|comment|whitespace|formatting|lint|changelog|version)\b/i;
const DOCUMENTATION = /\b(document|documentation|docs|readme|changelog|comment)\b/i;
const TESTS = /\b(test|tests|spec|coverage)\b/i;
const DEBUGGING = /\b(debug|root cause|reproduce|stack trace|failing|crash|regression)\b/i;

/** The most of the total work a planning dispatch may cost and still be worth
 *  buying.
 *
 *  Measured: a planning dispatch was ~119k tokens. Against a *single* execute
 *  dispatch of 1.77M that is 6.7% — which is why planning a goal that turns out
 *  not to split is a bad trade. Against the fan-out it would enable, two or
 *  more dispatches of that size, it is under 4%. The comparison is therefore
 *  against the whole expected work, not against one dispatch, and the threshold
 *  sits between those two numbers on purpose. */
export const PLANNING_COST_SHARE = 0.05;

/** Order is the whole design here, and each rung earns its place.
 *
 *  An explicit request to parallelise outranks every inference. A trivial edit
 *  is checked next, because "fix the typo in the README" names two work types —
 *  a fix and a document — and is one edit. Multi-workstream is checked before
 *  the narrow classes, because "fix auth, optimise the query layer and add API
 *  tests" mentions tests and is not a test-writing task. Only then do the narrow
 *  classes get a look, and implementation is the default because most work is. */
function classify(goal: string, decomposition: Decomposition): TaskClass {
  const { distinct_work_types: workTypes, separate_items: items } = decomposition.signals;

  if (decomposition.signals.explicit_split_request === 1) return 'multi_workstream';
  if (TRIVIAL.test(goal) && decomposition.complexity === 'low') return 'trivial_edit';

  // A real list of deliverables, not merely a sentence that brushes past
  // several verbs. Tied to `worthSplitting` so the class can never disagree
  // with the split decision — the confusion between *scope* and *divisibility*
  // is what cost a measured run a planner and five children.
  if (decomposition.worthSplitting && (items > 0 || workTypes >= 3)) return 'multi_workstream';

  if (DEBUGGING.test(goal)) return 'debugging';
  if (decomposition.investigative) return 'investigation';
  if (TESTS.test(goal)) return 'test_authoring';
  if (DOCUMENTATION.test(goal)) return 'documentation';
  return 'implementation';
}

export function judgeTask(goal: string): TaskVerdict {
  const decomposition = assessDecomposition(goal);
  const taskClass = classify(goal, decomposition);

  // A trivial edit gets the direct path: no planning, no split, no gate. The
  // whole apparatus for deciding how to divide work is itself work.
  if (taskClass === 'trivial_edit') {
    return {
      taskClass, direct: true, worthPlanning: false, planCacheEligible: false,
      reason: 'a one-line edit does not need a plan to decide it is a one-line edit',
      decomposition,
    };
  }

  if (!decomposition.worthSplitting) {
    return {
      taskClass, direct: false, worthPlanning: false,
      // Still cache-eligible: "this does not split" is exactly as stable an
      // answer as a split, and exactly as expensive to recompute.
      planCacheEligible: true,
      reason: 'the goal is one coherent unit, so a planner could only report that it does not split',
      decomposition,
    };
  }

  return {
    taskClass, direct: false, worthPlanning: true, planCacheEligible: true,
    reason: `the goal shows ${decomposition.signals.distinct_work_types} kinds of work across ${decomposition.signals.breadth_terms} breadth terms`,
    decomposition,
  };
}

/** Whether a planning dispatch is expected to pay for itself.
 *
 *  Expressed against the *work*, not in the abstract: planning saves by finding
 *  a split, a split saves by shortening the critical path, and neither is worth
 *  a sandbox when the work itself is small. */
export function planningPaysForItself(input: {
  verdict: TaskVerdict;
  /** Everything the task is expected to spend if it is split — not one
   *  dispatch. Planning that enables a fan-out is priced against the fan-out. */
  workTokens: number;
  planningTokens: number;
}): boolean {
  if (!input.verdict.worthPlanning) return false;
  if (input.workTokens <= 0) return false;
  return input.planningTokens / input.workTokens <= PLANNING_COST_SHARE;
}
