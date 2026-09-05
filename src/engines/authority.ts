import type { Authority } from '../schemas/node-contract.js';

// Doc §8's formula intersects capability/sandbox terms too — neither exists as a
// concrete signal anywhere in the codebase yet (no adapter reports capabilities,
// no sandbox-scope type exists), so this implements the three terms that are
// real today. Add the other two intersections here, not as a new function,
// once Phase 5's adapter capability-reporting lands.
export function effectiveAuthority(
  platformMax: Authority,
  parentGranted: Authority,
  childRequested: Authority,
): Authority {
  return {
    tools: childRequested.tools.filter(
      (tool) => platformMax.tools.includes(tool) && parentGranted.tools.includes(tool),
    ),
    spawn_children: platformMax.spawn_children && parentGranted.spawn_children && childRequested.spawn_children,
    max_child_count: Math.min(platformMax.max_child_count, parentGranted.max_child_count, childRequested.max_child_count),
    budget_usd: Math.min(platformMax.budget_usd, parentGranted.budget_usd, childRequested.budget_usd),
  };
}
