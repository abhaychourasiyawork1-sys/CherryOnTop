import type { ToolGrant } from '../adapters/adapter.js';

export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'LS'];

/** The grant a planning dispatch runs under: never more than read-only, and
 *  never wider than what the node itself holds. Planning inspects the repo to
 *  decide a split; it must not start doing the work. */
export function readOnlyPlanningGrant(grant: ToolGrant | undefined): ToolGrant {
  if (!grant || grant.allowedTools === null) {
    return { allowedTools: [...READ_ONLY_TOOLS], readOnly: true };
  }
  const intersection = grant.allowedTools.filter((t) => READ_ONLY_TOOLS.includes(t));
  return {
    allowedTools: intersection.length > 0 ? intersection : [...READ_ONLY_TOOLS],
    readOnly: true,
  };
}

/** The grant an *execute* dispatch runs under, narrowed to read-only for
 *  investigative goals ("review the codebase", "investigate the root cause of
 *  ...") when nobody configured a grant of their own.
 *
 *  An unrestricted grant (`allowedTools: null`) does not just permit editing —
 *  it also permits the Task tool, which is how a single dispatch spawns its
 *  own background subagents. A measured "review the codebase, do not modify
 *  anything" run had no explicit tool list, so it kept the Task tool, spawned
 *  five parallel subagents on its own initiative, and burned an entire 5-hour
 *  usage window on one node — the orchestrator's own turn cap and model tier
 *  bound the *top-level* dispatch and see none of that fan-out.
 *  Read/Grep/Glob/LS is everything "name a bug by file:line" needs and cannot
 *  spawn anything. An authority that already lists tools explicitly is left
 *  exactly as configured — this only fills in the default for "nobody said",
 *  the same convention `readOnlyPlanningGrant` already uses for planning. */
export function investigativeExecuteGrant(grant: ToolGrant, investigative: boolean): ToolGrant {
  if (!investigative || grant.allowedTools !== null) return grant;
  return { allowedTools: [...READ_ONLY_TOOLS], readOnly: true };
}

/** Turns a verification pass may take: run a test, read its output, report. */
export const PROOF_PASS_TURNS = 15;

export const PROOF_PASS_INSTRUCTION = [
  'Your change is already in place in this working tree from the previous attempt; do not redo it.',
  'The only thing missing is proof: run the narrowest existing test (or a short script) that exercises the change and show it passing.',
  'If no test can run in this environment, say exactly why in one sentence and stop. Do not rewrite the fix.',
].join(' ');

/** Whether the last validation rejected a change only for want of an observed
 *  check: something durable was produced (V1) and nothing was seen verifying
 *  it (V2). Re-running the whole task cannot supply that any better than a
 *  short pass that is asked for exactly that; measured on SWE-bench
 *  requests-1142, the full re-runs cost 3-4 dispatches and re-read the whole
 *  codebase each time. */
export function needsProofOnly(lastValidation: unknown): boolean {
  const v = lastValidation as { passed?: boolean; reasonCodes?: string[] } | undefined;
  if (!v || v.passed !== false || !Array.isArray(v.reasonCodes)) return false;
  return v.reasonCodes.includes('V1:durable_outcome_produced') && v.reasonCodes.includes('V2:no_observed_verification');
}
