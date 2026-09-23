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
