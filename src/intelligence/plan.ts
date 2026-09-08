/** Turning one goal into the subgoals a team can work on in parallel.
 *
 *  Until now `delegateToChild` handed the child its parent's goal verbatim, so
 *  "delegating" produced a chain of identical clones, each re-deciding the same
 *  thing and spending budget to do it. Decomposition is what makes delegation
 *  mean something. */

export const MAX_SUBGOALS = 5;

export function buildPlanPrompt(goal: string, maxChildren: number): string {
  const limit = Math.max(1, Math.min(maxChildren, MAX_SUBGOALS));
  // Task-specific content only. The role itself — plan, do not implement,
  // output a JSON array — is in the `plan` system stanza (src/prompts/roles.ts),
  // which is cached rather than resent with every turn.
  return [
    `Split this goal across up to ${limit} independent agents.`,
    '',
    `GOAL: ${goal}`,
    '',
    `Reply with ONLY a JSON array of up to ${limit} strings — one self-contained subgoal each,`,
    'written for an agent who cannot see this conversation. No subgoal may depend on or overlap another.',
    'Reply with exactly [] if the goal is already a single unit of work.',
    'Example: ["Audit src/auth for unhandled promise rejections", "Add tests for the cart discount edge cases"]',
  ].join('\n');
}

/** Pulls the subgoal list out of a planning run's final text. Tolerant of the
 *  wrappers models add — a code fence, a sentence before the array — because
 *  rejecting a good plan over a stray backtick means falling back to no
 *  delegation at all. */
export function parseSubgoals(text: string, maxChildren: number): string[] {
  if (!text) return [];
  const limit = Math.max(0, Math.min(maxChildren, MAX_SUBGOALS));

  // The last array in the text: a model that reasons first and answers last
  // would otherwise have its example or its scratch work parsed as the answer.
  const matches = [...text.matchAll(/\[[\s\S]*?\]/g)];
  for (const match of matches.reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    const subgoals = parsed
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    // A single subgoal is not a split — it is the original goal reworded, and
    // delegating it produces exactly the clone this module exists to prevent.
    if (subgoals.length < 2) return [];
    return subgoals.slice(0, limit);
  }
  return [];
}
