import type { Authority } from '../schemas/node-contract.js';

/** An empty `tools` list means unrestricted, not "no tools".
 *
 *  This is load-bearing and worth stating plainly: every node created before
 *  mandates existed has `tools: []`, and reading that as "may use nothing" would
 *  retroactively forbid every historical run from doing anything. The mandates
 *  the product ships all carry explicit lists, so the common path is the
 *  enforced path — but the sentinel for "no restriction" stays `[]`. */
export function isRestricted(authority: Pick<Authority, 'tools'>): boolean {
  return authority.tools.length > 0;
}

/** MCP tools arrive as `mcp__<server>__<tool>`. Granting a whole server is the
 *  useful granularity — nobody wants to list forty tools by hand — so a grant of
 *  `mcp__github` permits every tool that server exposes. */
function matches(granted: string, tool: string): boolean {
  if (granted === tool) return true;
  return tool.startsWith(`${granted}__`);
}

export function isToolAllowed(authority: Pick<Authority, 'tools'>, tool: string): boolean {
  if (!isRestricted(authority)) return true;
  return authority.tools.some((granted) => matches(granted, tool));
}

/** The tools a node may use, or null when it is unrestricted. Adapters pass this
 *  into the runtime's own permission flag, so a forbidden call is refused before
 *  it happens rather than reported after. */
export function allowedTools(authority: Pick<Authority, 'tools'>): string[] | null {
  return isRestricted(authority) ? [...authority.tools] : null;
}

/** Whether this grant can change anything on disk. Runtimes that have no
 *  per-tool allowlist (Codex) still have a read-only mode, and this is the
 *  question that picks it. */
export function isReadOnly(authority: Pick<Authority, 'tools'>): boolean {
  if (!isRestricted(authority)) return false;
  const WRITERS = ['Write', 'Edit', 'NotebookEdit', 'Bash'];
  return !authority.tools.some((tool) => WRITERS.includes(tool));
}
