/** The repository scan, shared across the Jobs that sit on one commit.
 *
 *  A fan-out starts N children at the same moment, all against the same tree.
 *  Without a shared scan each one runs its own `git ls-files` and reads every
 *  source file to say the same thing N times. Keyed by committed HEAD, so the
 *  scan is per repository *state* rather than per node.
 *
 *  The budget is deliberately not part of the key: what is cached is the
 *  unbudgeted inventory, and selection applies the current budget to it on every
 *  dispatch. Turning `ORG_REPO_MAP_TOKENS` down therefore bites on the next
 *  dispatch rather than the next commit — which is what the rendered-map cache
 *  needed a special re-check to achieve, and this does by construction. */
import type { Db } from '../db/client.js';
import { getRepoInventory, putRepoInventory } from '../db/queries/repo-map-cache.js';
import { buildRepoInventory, renderRepoMap, type RepoEntry } from '../intelligence/repo-map.js';
import { repoHead } from '../execution/git-state.js';
import { repoMapTokenBudget } from '../config/efficiency.js';
import { selectDispatchContext, estimateTokens, type DispatchContext } from './dispatch-context.js';

/** The inventory for this worktree's committed HEAD, built once and reused.
 *
 *  Keyed by HEAD only, deliberately unlike the plan cache: a stale plan changes
 *  what work happens, a slightly stale inventory only changes where an agent
 *  looks first, and it still reads the real files. Refusing a dirty tree would
 *  mean no context at all for most runs, since an agent dirties its own worktree
 *  as it works.
 *
 *  Total: git, the database or the scan failing must cost the dispatch its
 *  context, never the run. */
export function repoInventoryFor(db: Db, worktreePath: string): RepoEntry[] | null {
  try {
    const head = repoHead(worktreePath);
    if (!head) return null;

    const cached = getRepoInventory(db, head);
    if (cached) return cached;

    const entries = buildRepoInventory(worktreePath);
    if (entries.length === 0) return null;
    putRepoInventory(db, head, entries, new Date().toISOString());
    return entries;
  } catch (err) {
    console.error(`Failed to scan the repository at ${worktreePath}:`, err);
    return null;
  }
}

/** Warms the scan before a fan-out, so N children starting together do not each
 *  run an identical one. */
export function warmRepoInventory(db: Db, worktreePath: string): void {
  if (repoMapTokenBudget() <= 0) return;
  repoInventoryFor(db, worktreePath);
}

/** The part of the repository this goal is about, bounded by the configured
 *  ceiling. Null when there is nothing to say — the caller then dispatches the
 *  bare goal, exactly as before selection existed. */
export function dispatchContextFor(db: Db, worktreePath: string, goal: string): DispatchContext | null {
  // Read the budget before touching git: when context is switched off there is
  // nothing to look up and nothing to build, so do not fork a subprocess to key
  // a cache nobody will read.
  const tokenBudget = repoMapTokenBudget();
  if (tokenBudget <= 0) return null;

  const entries = repoInventoryFor(db, worktreePath);
  if (!entries) return null;

  try {
    const context = selectDispatchContext({ goal, entries, tokenBudget });
    return context.content ? context : null;
  } catch (err) {
    // Degrade upwards, never downwards: the whole inventory rendered to the
    // same ceiling is what every dispatch received before selection existed, so
    // a broken selector costs tokens rather than correctness.
    console.error('Falling back to the full repository map:', err);
    const content = renderRepoMap(entries, tokenBudget);
    if (!content) return null;
    return {
      content,
      estimatedTokens: estimateTokens(content),
      receipt: {
        budget: tokenBudget,
        selectedTokens: estimateTokens(content),
        selected: entries.map((entry) => entry.path),
        dropped: [],
        truncated: false,
        degraded: true,
      },
    };
  }
}
