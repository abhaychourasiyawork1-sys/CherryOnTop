/** Turning one goal into the subgoals a team can work on in parallel.
 *
 *  Until now `delegateToChild` handed the child its parent's goal verbatim, so
 *  "delegating" produced a chain of identical clones, each re-deciding the same
 *  thing and spending budget to do it. Decomposition is what makes delegation
 *  mean something. */

import { maxChildJobs } from '../config/efficiency.js';
import { isVerifyingCommand } from '../execution/observation.js';

/** The ceiling on a fan-out, over and above whatever authority a node holds.
 *  Read per call rather than captured at import: the daemon sets the
 *  environment, and a module-load-time constant is not overridable by it. */
export const MAX_SUBGOALS = (): number => maxChildJobs();

export interface PlanPromptOptions {
  /** The decision to split has already been made by two independent judges
   *  (System-1 and the deterministic split score). The planner is asked *how*
   *  to split, not *whether* — see `planVetoOverridden` in config/efficiency. */
  mustSplit?: boolean;
}

export function buildPlanPrompt(goal: string, maxChildren: number, options: PlanPromptOptions = {}): string {
  const limit = Math.max(1, Math.min(maxChildren, MAX_SUBGOALS()));
  // Task-specific content only. The role itself — plan, do not implement,
  // output a JSON array — is in the `plan` system stanza (src/prompts/roles.ts),
  // which is cached rather than resent with every turn.
  return [
    `Split this goal across up to ${limit} independent agents.`,
    '',
    `GOAL: ${goal}`,
    '',
    `Reply with ONLY a JSON array of up to ${limit} entries — one self-contained subgoal each,`,
    'written for an agent who cannot see this conversation. No two subgoals may overlap.',
    'An entry is a string, or {"goal": "...", "after": [indexes]} when it needs the output of earlier entries.',
    // What the parent will hold each piece to. Kept to what can be *shown*: a
    // check is accepted only as evidence, so a vague one could never be met.
    'An entry may also carry "done": [what that piece must produce] and "checks": [commands or files that prove it,',
    'e.g. "npm test -- cart" or "file:src/cart.tsx"]. Give a check only when a concrete command or file proves the piece; otherwise leave "checks" out.',
    'Only list an index in "after" that comes before the entry; pieces with no "after" run in parallel.',
    'A piece that others build on must write what it found to a file and name that file, so the later piece can read it.',
    options.mustSplit
      ? 'This goal has already been judged to split — your job is how, not whether. Reply with at least 2 entries; [] is not an acceptable answer here.'
      : 'Reply with exactly [] if the goal is already a single unit of work.',
    // Measured: a seaborn bug report was split into "investigate the bug" and
    // "implement the fix", two phases where the second needs the first, and
    // the split cost more than doing it directly. System-1 cannot tell a long
    // bug report from a multi-part task (live Laya: 0.91 on that bug report),
    // so the rule is stated here — but scoped to bugs and questions. Stated for
    // every goal it also vetoed "research, then redesign the site", a feature
    // whose research genuinely runs in parallel ahead of the build.
    'One bug report or one question is a single unit of work however long it is: never split it into investigate / fix / test phases.',
    'A larger feature may split into research that can run in parallel, followed by the build that uses it (give the build "after").',
    'Example: ["Audit src/auth for unhandled promise rejections", "Add tests for the cart discount edge cases"]',
    'Example: ["Research X and write findings to docs/x-notes.md", "Research Y and write findings to docs/y-notes.md", {"goal": "Build Z using docs/x-notes.md and docs/y-notes.md", "after": [0, 1]}]',
  ].join('\n');
}

/** Most a planner may ask of one piece. The contract is a checklist the child is
 *  handed and the parent verifies, not a specification. */
const MAX_DONE_ITEMS = 5;
const MAX_CHECKS = 3;
const MAX_ITEM_CHARS = 200;

/** Whether a check can be met by evidence the runtime can actually gather: a
 *  command that verifies something (a test, build, lint or typecheck), or a file
 *  that should exist in the candidate.
 *
 *  Acceptance is met by evidence alone, and silence is a failure — so a check
 *  that no run could ever evidence ("the cart renders correctly") would fail
 *  every piece it was attached to until the parent escalated. Refusing it here,
 *  where the plan is read, is what keeps a planner's optimism from becoming a
 *  rework loop. A file check must stay inside the workspace. */
export function isEvidenceableCheck(check: string): boolean {
  const file = /^file:\s*(.+)$/i.exec(check.trim());
  if (file) {
    const path = file[1].trim();
    return path.length > 0 && !path.startsWith('/') && !path.split(/[\\/]/).includes('..');
  }
  return isVerifyingCommand(check);
}

function textList(value: unknown, max: number, keep: (text: string) => boolean = () => true): string[] {
  const items = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  return items
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, MAX_ITEM_CHARS))
    .filter((item) => item.length > 0 && keep(item))
    .slice(0, max);
}

export interface ParsedPlan {
  subgoals: string[];
  /** Aligned with `subgoals`: the indexes each one must wait for. Always
   *  earlier indexes, so the graph is acyclic by construction. */
  after: number[][];
  /** Aligned with `subgoals`: what each piece must produce. Empty where the
   *  planner said nothing, and the piece's own goal stands in for it. */
  definitionOfDone: string[][];
  /** Aligned with `subgoals`: what the parent will require before accepting each
   *  piece, restricted to checks evidence can meet (see `isEvidenceableCheck`). */
  acceptanceChecks: string[][];
}

const NO_PLAN: ParsedPlan = { subgoals: [], after: [], definitionOfDone: [], acceptanceChecks: [] };

/** Every top-level JSON array in the text, the last one first: a model that
 *  reasons first and answers last would otherwise have its scratch work parsed
 *  as the answer. Found by bracket pairs rather than a regex, because an
 *  entry's own `"after": [0]` closes a lazy match early — and never an array
 *  nested inside one already found, or `[1, "0"]` would read as a plan. */
function arraysIn(text: string): unknown[][] {
  const opens = [...text.matchAll(/\[/g)].map((m) => m.index!);
  const closes = [...text.matchAll(/\]/g)].map((m) => m.index!);
  const found: unknown[][] = [];
  let coveredUntil = -1;
  for (const open of opens) {
    if (open <= coveredUntil) continue;
    for (const close of closes) {
      if (close < open) continue;
      try {
        const parsed: unknown = JSON.parse(text.slice(open, close + 1));
        if (Array.isArray(parsed)) {
          found.push(parsed);
          coveredUntil = close;
        }
        break;
      } catch {
        // not this closing bracket; try the next one
      }
    }
  }
  return found.reverse();
}

/** Pulls the plan out of a planning run's final text. Tolerant of the
 *  wrappers models add — a code fence, a sentence before the array — because
 *  rejecting a good plan over a stray backtick means falling back to no
 *  delegation at all. */
export function parsePlan(text: string, maxChildren: number): ParsedPlan {
  if (!text) return NO_PLAN;
  const limit = Math.max(0, Math.min(maxChildren, MAX_SUBGOALS()));

  for (const parsed of arraysIn(text)) {
    const entries = parsed
      .map((entry, index) => {
        if (typeof entry === 'string') {
          return { goal: entry.trim(), after: [] as unknown[], done: [] as string[], checks: [] as string[], index };
        }
        const { goal, after, done, checks } = (entry ?? {}) as { goal?: unknown; after?: unknown; done?: unknown; checks?: unknown };
        return typeof goal === 'string'
          ? {
            goal: goal.trim(), after: Array.isArray(after) ? after : [], index,
            done: textList(done, MAX_DONE_ITEMS), checks: textList(checks, MAX_CHECKS, isEvidenceableCheck),
          }
          : null;
      })
      .filter((entry): entry is { goal: string; after: unknown[]; done: string[]; checks: string[]; index: number } =>
        entry !== null && entry.goal.length > 0);
    if (entries.length === 0) {
      if (parsed.length === 0) return NO_PLAN;
      continue;
    }
    // A single subgoal is not a split — it is the original goal reworded, and
    // delegating it produces exactly the clone this module exists to prevent.
    if (entries.length < 2) return NO_PLAN;
    const kept = entries.slice(0, limit);
    // Indexes are the planner's, which counted any blank entry it emitted;
    // remap them onto what survived, and drop forward or dangling references.
    const position = new Map(kept.map((entry, i) => [entry.index, i]));
    return {
      subgoals: kept.map((entry) => entry.goal),
      after: kept.map((entry, i) => [...new Set(entry.after
        .map((ref) => (typeof ref === 'number' ? position.get(ref) : undefined))
        .filter((ref): ref is number => ref !== undefined && ref < i))]),
      definitionOfDone: kept.map((entry) => entry.done),
      acceptanceChecks: kept.map((entry) => entry.checks),
    };
  }
  return NO_PLAN;
}

export function parseSubgoals(text: string, maxChildren: number): string[] {
  return parsePlan(text, maxChildren).subgoals;
}
