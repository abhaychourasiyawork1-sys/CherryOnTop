/** What can be told about a task's economics before any of it is done.
 *
 *  Everything here is read off the goal string and the classification the
 *  runtime already computes (`judgeTask` / `assessDecomposition`). There is no
 *  model call, no repository read, and — the constraint that matters — no map
 *  from a task class to a set of files. A class emits *signals*; it never names
 *  context. The moment "documentation task" means "include README.md" the
 *  optimizer has stopped being general and started being a lookup table that
 *  happens to be wrong on the next repository.
 *
 *  Every output is normalized in `task-signals.ts`, so a caller can weight
 *  these against each other without knowing how any of them was derived. */
import { judgeTask, type TaskClass } from '../intelligence/task-judge.js';
import { normalizeTaskSignals } from './task-signals.js';
import type { TaskEconomicsSignals } from './policy-types.js';

/** A path, a dotted filename, or a backticked/camelCase identifier — the three
 *  ways a goal points at something specific. Deliberately conservative: a false
 *  anchor raises confidence, and confidence is what licenses pruning. */
const PATH = /\b[\w.-]+\/[\w./-]+\b/g;
const FILENAME = /\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|ya?ml|toml|py|go|rs|java|rb|sh|sql|css|html)\b/gi;
const BACKTICKED = /`([^`\n]{1,80})`/g;
/** `refreshSession`, `snake_case_thing` — two words fused, which English does
 *  not do and code does constantly. */
const IDENTIFIER = /\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;

/** What the goal named outright, deduplicated, in the order it named them. */
export function extractAnchors(goal: string): string[] {
  const found = new Set<string>();
  for (const pattern of [PATH, FILENAME, IDENTIFIER]) {
    for (const match of goal.match(pattern) ?? []) found.add(match);
  }
  for (const match of goal.matchAll(BACKTICKED)) {
    const inner = match[1].trim();
    if (inner) found.add(inner);
  }
  // A path already covers the filename inside it: "src/a/session.ts" and
  // "session.ts" are one anchor, and counting them twice would make a
  // single-file goal look like a two-file one.
  return [...found].filter((anchor) =>
    ![...found].some((other) => other !== anchor && other.endsWith(`/${anchor}`)));
}

/** Goals that say outright they will not write. Cheap, and only ever used to
 *  turn modification scope *down* — reading it wrong costs tokens, never an
 *  unwanted edit. */
const READ_ONLY = /\b(?:do not (?:modify|change|edit)|don't (?:modify|change|edit)|no edits|without (?:modifying|changing)|read[- ]only|investigate|review|audit|analyse|analyze|diagnose|explain)\b/i;

/** Words that widen a goal past whatever it named. Same vocabulary
 *  `decompose.ts` scores breadth with, kept here rather than imported because
 *  the two want different things from it — that one asks "does this split?",
 *  this one asks "how much of the tree is in play?". */
const BREADTH = /\b(?:all|every|entire|whole|across|each|codebase|repository|repo|everywhere|project[- ]wide|system[- ]wide)\b/gi;

/** How much of the work is looking rather than changing, by class. Signals,
 *  not recipes: these move a number, they do not select a file. */
const INVESTIGATION_BY_CLASS: Record<TaskClass, number> = {
  investigation: 0.9,
  debugging: 0.75,
  multi_workstream: 0.5,
  implementation: 0.35,
  test_authoring: 0.3,
  documentation: 0.3,
  trivial_edit: 0.1,
};

/** How much the result needs proving. Code that runs needs a test run; prose
 *  does not, and pretending otherwise buys turns that verify nothing. */
const VERIFICATION_BY_CLASS: Record<TaskClass, number> = {
  test_authoring: 0.95,
  implementation: 0.8,
  debugging: 0.8,
  multi_workstream: 0.7,
  trivial_edit: 0.4,
  investigation: 0.3,
  documentation: 0.25,
};

const BAND_BY_CLASS: Partial<Record<TaskClass, TaskEconomicsSignals['complexityBand']>> = {
  trivial_edit: 'tiny',
};

const BAND_BY_COMPLEXITY: Record<'low' | 'medium' | 'high', TaskEconomicsSignals['complexityBand']> = {
  low: 'small', medium: 'medium', high: 'large',
};

export interface TaskEconomicsInput {
  goal: string;
  taskClass: TaskClass | string;
  namedAnchors: string[];
  readOnly: boolean;
}

function classOf(taskClass: TaskClass | string): TaskClass {
  return taskClass in INVESTIGATION_BY_CLASS ? (taskClass as TaskClass) : 'implementation';
}

export function deriveTaskEconomicsSignals(input: TaskEconomicsInput): TaskEconomicsSignals {
  const taskClass = classOf(input.taskClass);
  const anchors = input.namedAnchors.filter(Boolean);
  const hasExplicitAnchors = anchors.length > 0;

  // Three breadth words say no more than two do; the scale saturates so a goal
  // cannot talk its way into unbounded breadth.
  const breadthTerms = (input.goal.match(BREADTH) ?? []).length;
  const breadth = Math.min(1, breadthTerms / 2.5);

  // Confidence is the pivot: it is what licenses pruning, so it only rises on
  // evidence the goal actually gave — a named anchor — and falls on the thing
  // that makes a goal vague, which is reaching across everything.
  const confidence = 0.4
    + (hasExplicitAnchors ? 0.35 : 0)
    + (anchors.length === 1 ? 0.1 : 0)
    - breadth * 0.35
    - (taskClass === 'investigation' ? 0.1 : 0);

  const investigationLikelihood = Math.min(
    1,
    INVESTIGATION_BY_CLASS[taskClass] + (input.readOnly ? 0.1 : 0),
  );

  // A read-only task modifies nothing; that is what read-only means, and it is
  // the one place a signal is allowed to be absolute.
  const expectedModificationScope = input.readOnly
    ? 0
    : Math.min(1, 0.15 + breadth * 0.55 + Math.max(0, anchors.length - 1) * 0.12
        + (taskClass === 'multi_workstream' ? 0.25 : 0)
        - (taskClass === 'trivial_edit' ? 0.12 : 0));

  return normalizeTaskSignals({
    confidence,
    breadth,
    hasExplicitAnchors,
    expectedModificationScope,
    investigationLikelihood,
    verificationNeed: input.readOnly
      ? Math.min(VERIFICATION_BY_CLASS[taskClass], 0.4)
      : VERIFICATION_BY_CLASS[taskClass],
    readOnly: input.readOnly,
    complexityBand: BAND_BY_CLASS[taskClass] ?? 'unknown',
  });
}

/** The signals for a goal, using the classification the runtime already
 *  computes. The convenience form: every caller in the runtime has a goal
 *  string and nothing else at the moment it needs these. */
export function taskEconomicsFor(goal: string): TaskEconomicsSignals {
  const verdict = judgeTask(goal);
  const signals = deriveTaskEconomicsSignals({
    goal,
    taskClass: verdict.taskClass,
    namedAnchors: extractAnchors(goal),
    // The runtime's own read: an investigative dispatch is already narrowed to
    // a read-only grant (`investigativeExecuteGrant`), so agreeing with it here
    // keeps the economics and the authority telling the same story.
    readOnly: verdict.decomposition.investigative || READ_ONLY.test(goal),
  });
  // The band comes from the difficulty assessment unless the class already
  // settled it — `trivial_edit` is tiny however elaborately it was described.
  return signals.complexityBand !== 'unknown'
    ? signals
    : { ...signals, complexityBand: BAND_BY_COMPLEXITY[verdict.decomposition.complexity] };
}
