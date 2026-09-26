/** `execution.change_requested`: may this execute dispatch edit, or does the
 *  goal ask only for an answer?
 *
 *  The grant used to be narrowed to read-only whenever a keyword such as "why"
 *  or "review" appeared anywhere in the goal. A SWE-bench bug report ("I am
 *  confused why…") lost its edit tools that way, found the fix, and could not
 *  apply it. One word cannot tell "why does X crash, please fix" from "explain
 *  why X", which is a semantic question and so System-1's.
 *
 *  Asked only when the answer can change the grant and the words do not
 *  settle it: a goal with no investigative wording was never narrowed, one
 *  that says "do not modify" is read-only, and one that names a change ("fix",
 *  "add", "expected", "should") keeps its tools whatever a model thinks.
 *  Measured on live Laya (typed-decisions), raw P(explain) put "investigate
 *  why login fails … and fix it" at 0.72 and the SWE-bench xarray report at
 *  0.58, against 0.61-0.83 for real explanation requests: good enough to
 *  decide what the words leave open, not to overrule them. Read-only needs a
 *  confident "explain"; anything less keeps the tools, because a wrong
 *  read-only grant costs the whole task while a wrong writable one only costs
 *  the narrowing. With no answer, the rule in `decompose.ts` decides. */
import { assessDecomposition } from '../intelligence/decompose.js';
import { compileHarnessRequest } from './compiler.js';
import { system1 as defaultSystem1, type JudgeOutcome, type System1 } from './guard.js';

// ponytail: an uncalibrated threshold on the raw probability. Fit a Platt
// calibrator for this surface (bench/system1-calibrate.mjs) once there is a
// labelled set, as was done for execution.decomposable.
export const EXPLAIN_THRESHOLD = 0.7;

export interface ChangeRequestVerdict {
  readOnly: boolean;
  /** Who decided: the rule without asking, System-1, or the rule because
   *  System-1 could not answer. */
  decidedBy: 'rule' | 'system1' | 'fallback';
  outcome?: JudgeOutcome;
  pExplain?: number;
  fallbackReason?: string;
}

export async function assessChangeRequest(
  scope: string,
  goal: string,
  s1: System1 = defaultSystem1(),
): Promise<ChangeRequestVerdict> {
  const d = assessDecomposition(goal);
  if (!d.investigative && !d.explanationOnly) return { readOnly: false, decidedBy: 'rule' };
  if (d.signals.change_request_terms) return { readOnly: false, decidedBy: 'rule' };
  if (d.signals.explicit_no_change) return { readOnly: true, decidedBy: 'rule' };

  const [outcome] = await s1.judge(scope, [compileHarnessRequest({
    surface: 'execution.change_requested', goal, stateVersion: 0,
  })], { orchestration: 0.5 });
  const p = outcome.judgment?.result.probabilities?.explain;
  if (p === undefined) {
    return {
      readOnly: d.explanationOnly, decidedBy: 'fallback', outcome,
      fallbackReason: outcome.failure?.reason ?? 'no judgment',
    };
  }
  return { readOnly: p >= EXPLAIN_THRESHOLD, decidedBy: 'system1', outcome, pExplain: p };
}
