/** What can be told about a task's economics before any of it is done.
 *
 *  Nothing here judges what the goal *means*. The signals come from three
 *  things: what the goal literally names (anchors — syntax), whether the task
 *  asks only for an answer (System-1's typed answer, carried in
 *  `TaskUnderstanding`), and honest uncertainty for everything else. A goal's
 *  breadth, kind of work and difficulty cannot be read off its wording, and a
 *  guess dressed as a signal is what every policy downstream would then trust.
 *
 *  Every output is normalized in `task-signals.ts`, so a caller can weight
 *  these against each other without knowing how any of them was derived. */
import { normalizeTaskSignals } from './task-signals.js';
import type { TaskEconomicsSignals } from './policy-types.js';
import type { TaskUnderstanding } from '../intelligence/task-understanding.js';

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

/** How much the result needs proving when the task changes something. The
 *  validation ladder's own default for work that runs: an observed check, not
 *  merely a file that changed. */
const VERIFICATION_WHEN_WRITING = 0.8;
/** An answer is judged on what it says, so it needs less proving. */
const VERIFICATION_WHEN_READ_ONLY = 0.4;

export interface TaskEconomicsInput {
  anchors: string[];
  readOnly: boolean;
}

export function deriveTaskEconomicsSignals(input: TaskEconomicsInput): TaskEconomicsSignals {
  const anchors = input.anchors.filter(Boolean);
  const hasExplicitAnchors = anchors.length > 0;

  // Confidence is the pivot: it is what licenses pruning, so it only rises on
  // evidence the goal actually gave — a named anchor. Nothing lowers it by
  // reading the goal: reaching across everything is not something a word list
  // can see.
  const confidence = 0.4 + (hasExplicitAnchors ? 0.35 : 0) + (anchors.length === 1 ? 0.1 : 0);

  // A goal that names where it works reaches less than one that names nothing.
  const breadth = 1 - Math.min(1, confidence);

  // Answering is investigating; changing something anchored is mostly doing.
  const investigationLikelihood = input.readOnly ? 1 : 1 - confidence;

  // A read-only task modifies nothing; that is what read-only means, and it is
  // the one place a signal is allowed to be absolute.
  const expectedModificationScope = input.readOnly
    ? 0
    : Math.min(1, 0.15 + breadth * 0.55 + Math.max(0, anchors.length - 1) * 0.12);

  return normalizeTaskSignals({
    confidence,
    breadth,
    hasExplicitAnchors,
    expectedModificationScope,
    investigationLikelihood,
    verificationNeed: input.readOnly ? VERIFICATION_WHEN_READ_ONLY : VERIFICATION_WHEN_WRITING,
    readOnly: input.readOnly,
    // Size is not knowable from the words; the difficulty belief carries it.
    complexityBand: 'unknown',
  });
}

/** The signals for a goal. `understanding` carries what System-1 has answered;
 *  without it the task is assumed to write, because assuming it writes nothing
 *  is the assumption that costs an unwanted edit rather than a few tokens. */
export function taskEconomicsFor(goal: string, understanding?: Pick<TaskUnderstanding, 'readOnly' | 'anchors'>): TaskEconomicsSignals {
  return deriveTaskEconomicsSignals({
    anchors: understanding?.anchors ?? extractAnchors(goal),
    readOnly: understanding?.readOnly === true,
  });
}
