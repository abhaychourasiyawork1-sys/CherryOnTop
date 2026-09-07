/** Is this goal actually several pieces of work, or one?
 *
 *  The old signal was `goal.length > 150 ? 'high' : ...` — the number of
 *  characters someone typed. A single careful sentence about one function scored
 *  "high" and went off to delegate; a terse "audit every module" scored "low"
 *  and did not. When the economics then chose to delegate, the node paid for a
 *  whole planning sandbox just to be told the goal does not split.
 *
 *  This looks at what the goal actually asks for instead. It is a heuristic and
 *  says so, but every signal it fires on is named in the decision breakdown, so
 *  a wrong call is visible rather than mysterious. */

export interface Decomposition {
  complexity: 'low' | 'medium' | 'high';
  /** Worth paying a planner to try splitting this. */
  worthSplitting: boolean;
  /** The named signals, which ride along into the decision record. */
  signals: Record<string, number>;
}

/** Asking for the same kind of work over many things — the case that genuinely
 *  parallelises. */
const BREADTH = /\b(every|each|all|across|entire|whole|throughout|codebase|repository|repo-wide|modules?|packages?|services?|directories)\b/gi;

/** Several different deliverables in one sentence. */
const CONJUNCTION = /(\band then\b|\balso\b|\bas well as\b|\bplus\b|;|\n\s*[-*•]\s|\n\s*\d+[.)]\s)/gi;

/** Named work types. Two or more distinct ones is a real split. */
const WORK_TYPES = [
  /\b(test|tests|testing)\b/i, /\b(document|documentation|docs|readme)\b/i,
  /\b(refactor|rewrite|restructure)\b/i, /\b(review|audit|analy[sz]e|inspect)\b/i,
  /\b(fix|repair|patch|debug)\b/i, /\b(implement|add|build|create)\b/i,
  /\b(migrat|upgrad|port)\w*\b/i, /\b(benchmark|profile|optimi[sz]e)\b/i,
];

/** Pointing at one specific thing — the clearest sign this is a single unit. */
// Extensionless filenames are named targets too: "fix the typo in the README"
// is one job, and counting README as a *documentation work type* was enough to
// send it off to be split.
const SINGLE_TARGET = /\b(only|just|single|one)\b|\b(readme|license|changelog|dockerfile|makefile)\b|\b[\w/.-]+\.(ts|tsx|js|jsx|py|go|rs|java|rb|md|json|yaml|yml|css|html)\b/gi;

function count(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

export function assessDecomposition(goal: string): Decomposition {
  const breadth = count(goal, BREADTH);
  const conjunctions = count(goal, CONJUNCTION);
  const workTypes = WORK_TYPES.filter((pattern) => pattern.test(goal)).length;
  const singleTarget = count(goal, SINGLE_TARGET);

  // Breadth is the strongest signal and distinct work types the next; a named
  // single file pulls hard the other way, because "fix the bug in parser.ts" is
  // one job however elaborately it is described.
  const score = breadth * 2 + conjunctions + Math.max(0, workTypes - 1) * 1.5 - singleTarget * 2;

  const signals = {
    breadth_terms: breadth,
    separate_items: conjunctions,
    distinct_work_types: workTypes,
    named_single_targets: singleTarget,
    decomposition_score: Number(score.toFixed(2)),
  };

  if (score >= 3) return { complexity: 'high', worthSplitting: true, signals };
  if (score >= 1.5) return { complexity: 'medium', worthSplitting: true, signals };
  return { complexity: 'low', worthSplitting: false, signals };
}
