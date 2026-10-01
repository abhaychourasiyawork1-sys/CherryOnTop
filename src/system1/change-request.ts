/** `execution.change_requested`: may this execute dispatch edit, or does the
 *  goal ask only for an answer?
 *
 *  The grant used to be narrowed to read-only whenever a keyword such as "why"
 *  or "review" appeared anywhere in the goal. A SWE-bench bug report ("I am
 *  confused why…") lost its edit tools that way, found the fix, and could not
 *  apply it. One word cannot tell "why does X crash, please fix" from "explain
 *  why X", which is a semantic question and so System-1's — and only System-1's:
 *  a word-list rule ahead of it decides the same question with the same blind
 *  spot, so there is none.
 *
 *  Measured on live Laya (typed-decisions), raw P(explain) put "investigate
 *  why login fails … and fix it" at 0.72 and the SWE-bench xarray report at
 *  0.58, against 0.61-0.83 for real explanation requests. Read-only needs a
 *  confident "explain"; anything less keeps the tools, because a wrong
 *  read-only grant costs the whole task while a wrong writable one only costs
 *  the narrowing. With no answer the grant stays writable — never a keyword
 *  rule standing in for the judgment. */
import { compileHarnessRequest } from './compiler.js';
import { system1 as defaultSystem1, type JudgeOutcome, type System1 } from './guard.js';

// ponytail: an uncalibrated threshold on the raw probability. Fit a Platt
// calibrator for this surface (bench/system1-calibrate.mjs) once there is a
// labelled set, as was done for execution.decomposable.
export const EXPLAIN_THRESHOLD = 0.7;

export interface ChangeRequestVerdict {
  readOnly: boolean;
  /** Who decided: System-1, or the writable default because System-1 could not
   *  answer. */
  decidedBy: 'system1' | 'fallback';
  outcome?: JudgeOutcome;
  pExplain?: number;
  fallbackReason?: string;
}

export async function assessChangeRequest(
  scope: string,
  goal: string,
  s1: System1 = defaultSystem1(),
): Promise<ChangeRequestVerdict> {
  const [outcome] = await s1.judge(scope, [compileHarnessRequest({
    surface: 'execution.change_requested', goal, stateVersion: 0,
  })], { orchestration: 0.5 });
  const p = outcome.judgment?.result.probabilities?.explain;
  if (p === undefined) {
    return {
      readOnly: false, decidedBy: 'fallback', outcome,
      fallbackReason: outcome.failure?.reason ?? 'no judgment',
    };
  }
  return { readOnly: p >= EXPLAIN_THRESHOLD, decidedBy: 'system1', outcome, pExplain: p };
}
