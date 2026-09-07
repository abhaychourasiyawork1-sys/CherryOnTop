/** Prefixes a goal with the contract's constraints.
 *
 *  This is the honest half of `constraints`: the platform cannot enforce "do not
 *  touch the database" the way it enforces a budget or a tool grant, so the
 *  constraint is *told* to the agent and labelled everywhere in the interface as
 *  told-not-enforced. Before this it was written to the contract and read by
 *  nothing at all, which is worse than either: a boundary a user believes in and
 *  the system never applies. */
export function withConstraints(goal: string, constraints: string[]): string {
  const real = constraints.map((line) => line.trim()).filter(Boolean);
  if (real.length === 0) return goal;
  return [
    'You are working under the following standing instructions. Follow them even where they',
    'conflict with the most direct way to achieve the task, and say so if one blocks you:',
    ...real.map((line) => `  - ${line}`),
    '',
    goal,
  ].join('\n');
}
