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
