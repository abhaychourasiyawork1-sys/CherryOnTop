/** Exercises the context planner over representative goal shapes and prints the
 *  receipts. Used once, to freeze the pre-implementation baseline. */
import { buildRepoInventory } from '../src/intelligence/repo-map.js';
import { selectDispatchContext } from '../src/context/dispatch-context.js';

const GOALS = [
  ['tiny', 'Fix a typo in README.md'],
  ['medium', 'Add a unit test for src/engines/economics.ts scoreDelegation tolerance behaviour'],
  ['broad', 'Review the codebase and find bugs. Do not modify anything.'],
  ['low-confidence', 'make it better'],
];

const entries = buildRepoInventory(process.cwd());
for (const [label, goal] of GOALS) {
  const ctx = selectDispatchContext({ goal, entries, tokenBudget: 6000 });
  const r = ctx.receipt;
  console.log(JSON.stringify({
    label, goal, budget: r.budget, estimatedTokens: ctx.estimatedTokens,
    candidates: r.candidates, selected: r.selected.length, truncated: r.truncated,
    confidence: Number((r.confidence ?? 0).toFixed(4)), policyVersion: r.policyVersion,
    structural: r.structural, topSelected: r.selected.slice(0, 5),
  }));
}
