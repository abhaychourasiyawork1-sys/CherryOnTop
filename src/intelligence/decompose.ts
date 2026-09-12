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

import { efficiencyMode } from '../config/efficiency.js';

export interface Decomposition {
  complexity: 'low' | 'medium' | 'high';
  /** Worth paying a planner to try splitting this. */
  worthSplitting: boolean;
  /** Reading, reasoning and diagnosing rather than producing. Separate from
   *  complexity because these two disagree: "investigate the root cause of this
   *  bug" names nothing broad, so it scores low, and low is what routes a goal
   *  to the fast tier. Diagnosis is the last thing that should be tiered down. */
  investigative: boolean;
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

/** Work whose product is an understanding, not a change. Cheap to run and
 *  expensive to get wrong: a missed bug or a wrong root cause is not visible in
 *  the output the way a failed edit is. */
const INVESTIGATIVE = /\b(review|audit|analy[sz]e|investigat\w*|diagnos\w*|debug|inspect|understand|why|root cause|assess|evaluate|trace)\b/i;

/** The user asking for a fan-out in so many words. Scope inference must never
 *  override this: if someone says "split this across agents", that is not a
 *  heuristic call any more. */
const EXPLICIT_SPLIT = /\b(in parallel|split (this|the work|it)\b|across (multiple|several|\d+) agents|one agent (per|for each)|fan ?out)\b/i;

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

  // Difficulty and splittability are two different questions, and sharing one
  // score for both is what sent "review the codebase for bugs" to five agents.
  // Breadth makes a goal *big*, which is a reason to keep the strong model —
  // `modelChoiceFor` routes on this complexity — but on its own it says nothing
  // about whether the work comes apart. "Review the codebase" is one coherent
  // investigation that happens to cover a lot of ground; it has no seam to cut
  // along. Breadth only becomes a split signal once there is more than one kind
  // of work to spread across it.
  // `disabled` and `shadow` keep the old rule — breadth alone splits — so
  // `bench/run.mjs efficiency` compares exactly this change against exactly the
  // behaviour it replaces. The signals below are recorded either way, so a
  // shadow run's decision rows still show what the new rule would have done.
  const applied = efficiencyMode() === 'enabled';
  const explicit = EXPLICIT_SPLIT.test(goal);
  const coherent = !explicit && workTypes <= 1 && conjunctions === 0;
  const splitScore = coherent && applied ? score - breadth * 2 : score;

  const signals = {
    breadth_terms: breadth,
    separate_items: conjunctions,
    distinct_work_types: workTypes,
    named_single_targets: singleTarget,
    decomposition_score: Number(score.toFixed(2)),
    split_score: Number(splitScore.toFixed(2)),
    coherent_single_task: coherent ? 1 : 0,
    explicit_split_request: explicit ? 1 : 0,
  };

  const complexity = score >= 3 ? 'high' : score >= 1.5 ? 'medium' : 'low';
  return {
    complexity,
    worthSplitting: explicit || splitScore >= 1.5,
    investigative: INVESTIGATIVE.test(goal),
    signals,
  };
}
