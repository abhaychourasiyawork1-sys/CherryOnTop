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
import { repoMapTokenBudget, runtimeMode } from '../config/efficiency.js';
import { selectDispatchContext, estimateTokens, type DispatchContext } from './dispatch-context.js';
import type { ContextPolicy, TaskEconomicsSignals } from '../efficiency/policy-types.js';

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

/** What siblings on one commit have already been shown, keyed by that commit.
 *
 *  A fan-out's children are dispatched within seconds of each other against the
 *  same tree, and each one independently re-scores the repository from its own
 *  subgoal. Two children investigating the same module select overlapping files
 *  and rediscover the same thing — the `shared-information` regime's measured
 *  regression. Feeding the earlier selection in as `previouslySelected` makes
 *  the selector prefer paths a sibling already paid for, which both keeps the
 *  prompt prefix stable (the provider's cache is keyed on it) and stops the
 *  second child from reading its way to the same answer.
 *
 *  Process-local and unbounded-in-principle; bounded in practice by how many
 *  commits one daemon process sees. It is a hint, never a correctness input:
 *  losing it costs tokens, never an answer.
 *
 *  ponytail: in-memory map, per process. If daemons ever shard, this wants to
 *  be the `knowledge` table keyed by (repository, revision). */
const siblingSelections = new Map<string, Set<string>>();

/** Forgets one commit's shared selections. Called when nothing else will run
 *  against that tree. */
export function forgetSiblingSelections(head: string): void {
  siblingSelections.delete(head);
}

/** The part of the repository this goal is about, bounded by the configured
 *  ceiling. Null when there is nothing to say — the caller then dispatches the
 *  bare goal, exactly as before selection existed. */
export function dispatchContextFor(
  db: Db,
  worktreePath: string,
  goal: string,
  /** The signals and ceiling the dispatch snapshot already derived. Absent
   *  means derive them here, which is what every pre-snapshot caller did — the
   *  point of passing them is that the selector and the strategy gate reason
   *  from one answer rather than two. */
  prepared?: { signals?: TaskEconomicsSignals; policy?: ContextPolicy },
): DispatchContext | null {
  // Read the budget before touching git: when context is switched off there is
  // nothing to look up and nothing to build, so do not fork a subprocess to key
  // a cache nobody will read.
  const tokenBudget = repoMapTokenBudget();
  if (tokenBudget <= 0) return null;

  const entries = repoInventoryFor(db, worktreePath);
  if (!entries) return null;

  // Keyed on the committed revision, so a sibling's selection is only ever
  // offered to a dispatch looking at the same tree.
  const head = repoHead(worktreePath);
  const shared = head ? (siblingSelections.get(head) ?? new Set<string>()) : undefined;

  try {
    const context = selectDispatchContext({
      goal, entries, tokenBudget,
      previouslySelected: shared,
      ...(prepared?.signals ? { signals: prepared.signals } : {}),
      ...(prepared?.policy ? { policy: prepared.policy } : {}),
    });
    if (head && context.receipt.selected.length > 0) {
      const seen = siblingSelections.get(head) ?? new Set<string>();
      for (const path of context.receipt.selected) seen.add(path);
      siblingSelections.set(head, seen);
    }
    // `disabled` is the behaviour this branch shipped with: the whole inventory
    // rendered to the ceiling, on every dispatch. `shadow` runs selection and
    // publishes its receipt — so a deployment can see what it would have
    // dropped — but still dispatches the full map, which is what makes a shadow
    // run comparable to a baseline one.
    if (runtimeMode() === 'full') {
      return context.content ? { ...context, receipt: { ...context.receipt, applied: true } } : null;
    }
    const full = renderRepoMap(entries, tokenBudget);
    if (!full) return null;
    return {
      content: full,
      estimatedTokens: estimateTokens(full),
      receipt: { ...context.receipt, applied: false },
    };
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
        applied: false,
      },
    };
  }
}
