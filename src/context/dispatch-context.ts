/** Choosing the part of the repository a dispatch is actually about.
 *
 *  Until now every child was handed the same map: the whole file tree plus every
 *  top-level symbol, rendered up to `ORG_REPO_MAP_TOKENS` and prefixed to the
 *  goal. The budget was treated as a target, so a one-file typo fix and a
 *  repo-wide audit received exactly the same six thousand tokens — and with N
 *  children, N copies of it.
 *
 *  This selects instead. The budget becomes a ceiling nothing tries to reach,
 *  the shape of the repository is always shown so selection can never be worse
 *  than nothing, and the receipt records what was dropped so a bad selection is
 *  visible rather than mysterious.
 *
 *  Deterministic and model-free, like `decompose` and `select-runtime`: the same
 *  goal against the same tree selects the same context, which is what makes it
 *  cacheable across the sibling Jobs that all sit on one commit.
 *
 *  Two selectors live here now. The lexical one below is what this branch
 *  shipped with, kept intact and reachable by `ORG_CONTEXT_PLANNER=off` — a
 *  rollback that is an environment variable rather than a revert. The
 *  structural one composes `candidates.ts`, `scoring.ts` and `selector.ts`, and
 *  is what runs by default: it adds the two things lexical matching cannot see,
 *  which are the compiler's own edges and the difference between a budget and a
 *  target. */
import type { RepoEntry } from '../intelligence/repo-map.js';
import { buildCandidates, renderAt } from './candidates.js';
import { createContextScorer } from './scoring.js';
import { selectContext } from './selector.js';
import { contextPlannerEnabled } from '../config/efficiency.js';
import { contextPolicyFor, CONTEXT_POLICY_VERSION } from '../efficiency/policy.js';
import { extractAnchors, taskEconomicsFor } from '../efficiency/task-economics.js';
import type { ContextPolicy, TaskEconomicsSignals } from '../efficiency/policy-types.js';

const CHARS_PER_TOKEN = 4;

/** The share of the budget the repository skeleton may take. It is the floor
 *  that keeps selection safe, not the payload, so it must never crowd out the
 *  files the goal actually named. */
const SKELETON_SHARE = 0.3;

/** Below this there is nothing worth saying: the skeleton header alone is most
 *  of it. The narrowing a policy does is bounded by this from below. */
const MIN_USEFUL_TOKENS = 200;

/** A path match is worth more than a symbol match: a goal that names
 *  `session.ts` is about that file, while a goal containing the word "login"
 *  merely brushes past every file exporting a `login`. */
const PATH_WEIGHT = 2;
const SYMBOL_WEIGHT = 1;

/** Words that appear in every goal and select nothing. Without these, "the",
 *  "for" and "with" match half the repository and the selection is the full map
 *  again by another route. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'onto', 'about',
  'all', 'any', 'are', 'but', 'can', 'has', 'have', 'its', 'not', 'out', 'over',
  'should', 'than', 'them', 'then', 'they', 'was', 'were', 'when', 'where',
  'which', 'while', 'will', 'would', 'you', 'your', 'our', 'use', 'using',
  'make', 'made', 'get', 'set', 'run', 'add', 'new', 'old', 'one', 'two',
  'src', 'lib', 'test', 'tests', 'file', 'files', 'code', 'please', 'need',
]);

export interface DispatchReceipt {
  /** The ceiling this selection was made under. */
  budget: number;
  selectedTokens: number;
  /** Paths that made it in, best first. */
  selected: string[];
  /** Paths that did not — because nothing tied them to the goal, or because
   *  what did tie them ran out of room. */
  dropped: string[];
  /** True when something scoring above zero could not fit. The signal that the
   *  budget, not the goal, is what bounded this dispatch. */
  truncated: boolean;
  /** True when selection could not run and this is the whole inventory rendered
   *  down instead. Degrading means a *larger* bounded context, never a smaller
   *  one — a selector that fails must not quietly starve the agent. */
  degraded?: boolean;
  /** False when this selection was computed but not used — shadow mode. The
   *  receipt still records what it *would* have dropped, which is the whole
   *  point of running a shadow: seeing the change before taking it. */
  applied?: boolean;
  /** How many files had any evidence tying them to the goal at all. Against
   *  `selected.length` it answers "did the budget bound this, or did the goal?" */
  candidates?: number;
  /** Mean confidence of what was selected, on [0,1]. A selection made from weak
   *  evidence and one made from an explicit anchor are different events, and
   *  without this they look identical in the ledger. */
  confidence?: number;
  /** Which planner produced this, so two generations in one database are
   *  distinguishable rather than averaged into an uninterpretable middle. */
  policyVersion?: string;
  /** True when the structural planner ran; false on the lexical fallback. */
  structural?: boolean;
}

export interface DispatchContext {
  content: string;
  estimatedTokens: number;
  receipt: DispatchReceipt;
}

export interface DispatchContextInput {
  goal: string;
  entries: RepoEntry[];
  /** The ceiling. Kept as the primary knob so every existing caller — and the
   *  deterministic benchmark — still works unchanged; `policy` overrides it
   *  when the caller has already derived one. */
  tokenBudget: number;
  policy?: ContextPolicy;
  signals?: TaskEconomicsSignals;
  /** Paths a sibling dispatch on this commit already received. Selecting them
   *  again keeps the prompt prefix identical, which is what the provider's
   *  cache is keyed on. */
  previouslySelected?: Iterable<string>;
}

/** The same rough conversion the rest of the repo-map path sizes itself with. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** `refreshSession` -> refresh, session. A goal is written in English; a symbol
 *  is written in camelCase, and without splitting it the two never meet. */
function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Crude singular/plural folding, so "sessions" in a goal finds `session.ts`.
 *  Not a stemmer — a stemmer is a dependency, and this covers the case that
 *  actually comes up in goals people write. */
function fold(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

function meaningfulTerms(text: string): Set<string> {
  return new Set(
    words(text)
      .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
      .map(fold),
  );
}

/** How many distinct goal terms this file answers to, weighted by where they
 *  matched. Zero means nothing connects them, and a zero-scoring file is
 *  dropped rather than used to top the budget up. */
function scoreEntry(entry: RepoEntry, goalTerms: Set<string>): number {
  if (goalTerms.size === 0) return 0;
  const pathTerms = new Set(words(entry.path).map(fold));
  const symbolTerms = new Set(entry.symbols.flatMap((symbol) => words(symbol)).map(fold));

  let score = 0;
  for (const term of goalTerms) {
    if (pathTerms.has(term)) score += PATH_WEIGHT;
    else if (symbolTerms.has(term)) score += SYMBOL_WEIGHT;
  }
  return score;
}

/** One line per directory, with how much is in it. The floor beneath selection:
 *  even a goal that matches nothing leaves the agent knowing the repository's
 *  shape, so selecting can never be worse than the map it replaces. */
function skeletonLines(entries: RepoEntry[]): string[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const slash = entry.path.lastIndexOf('/');
    const dir = slash === -1 ? '.' : entry.path.slice(0, slash);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([dir, count]) => `  ${dir}/ (${count} file${count === 1 ? '' : 's'})`);
}

function entryLine(entry: RepoEntry): string {
  return entry.symbols.length > 0
    ? `  ${entry.path}: ${entry.symbols.join(', ')}`
    : `  ${entry.path}`;
}

/** Appends whichever of `lines` fit under `budgetChars`, header included, and
 *  reports what it could not take. Nothing is emitted at all when even the
 *  header does not fit — a fragment that still busts the ceiling is worse than
 *  no section. */
function fitSection(header: string, lines: string[], budgetChars: number): { text: string; taken: number } {
  if (lines.length === 0 || header.length > budgetChars) return { text: '', taken: 0 };
  const kept: string[] = [];
  let used = header.length;
  for (const line of lines) {
    if (used + 1 + line.length > budgetChars) break;
    kept.push(line);
    used += 1 + line.length;
  }
  if (kept.length === 0) return { text: '', taken: 0 };
  return { text: [header, ...kept].join('\n'), taken: kept.length };
}

/** The lexical selector this branch shipped with. Reachable by
 *  `ORG_CONTEXT_PLANNER=off`, and the fallback whenever the structural planner
 *  throws — degrading has to land somewhere that still works. */
export function selectLexicalContext(input: DispatchContextInput): DispatchContext {
  const budgetChars = Math.max(0, Math.floor(input.tokenBudget)) * CHARS_PER_TOKEN;
  const empty: DispatchContext = {
    content: '',
    estimatedTokens: 0,
    receipt: { budget: input.tokenBudget, selectedTokens: 0, selected: [], dropped: [], truncated: false },
  };
  if (budgetChars <= 0 || input.entries.length === 0) return empty;

  // Two entries for one path would otherwise be selected, rendered and paid for
  // twice — and a repo map built from two scans is exactly where that comes from.
  const unique = [...new Map(input.entries.map((entry) => [entry.path, entry])).values()];

  const goalTerms = meaningfulTerms(input.goal);
  const scored = unique
    .map((entry) => ({ entry, score: scoreEntry(entry, goalTerms) }))
    .filter((candidate) => candidate.score > 0)
    // Path as the tie-break, so the same goal and tree always render the same
    // bytes — which is what makes the result safe to cache across siblings.
    .sort((a, b) => b.score - a.score || (a.entry.path < b.entry.path ? -1 : 1));

  // The skeleton is capped rather than given the whole budget: it is the safety
  // floor, and a repository with a thousand directories must not be able to
  // squeeze out the one file the goal named.
  const skeleton = fitSection(
    'Repository shape:',
    skeletonLines(unique),
    Math.floor(budgetChars * SKELETON_SHARE),
  );

  const remaining = budgetChars - skeleton.text.length - (skeleton.text ? 2 : 0);
  const relevant = fitSection(
    'Files this goal points at:',
    scored.map((candidate) => entryLine(candidate.entry)),
    Math.max(0, remaining),
  );

  const selected = scored.slice(0, relevant.taken).map((candidate) => candidate.entry.path);
  const selectedSet = new Set(selected);
  const content = [skeleton.text, relevant.text].filter(Boolean).join('\n\n');

  return {
    content,
    estimatedTokens: estimateTokens(content),
    receipt: {
      budget: input.tokenBudget,
      selectedTokens: estimateTokens(content),
      selected,
      dropped: unique.map((entry) => entry.path).filter((path) => !selectedSet.has(path)),
      truncated: relevant.taken < scored.length,
      candidates: scored.length,
      confidence: scored.length === 0 ? 0 : 0.5,
      policyVersion: 'lexical',
      structural: false,
    },
  };
}

/** The structural planner: candidates, scored, selected under a policy.
 *
 *  The skeleton stays exactly where it was — capped at a share of the budget,
 *  emitted first, and never crowded out. It is the floor that makes selecting
 *  safe: a goal that matches nothing still leaves the agent knowing the shape
 *  of the repository, so selection can never be worse than the map it
 *  replaces. */
export function selectStructuralContext(input: DispatchContextInput): DispatchContext {
  const signals = input.signals ?? taskEconomicsFor(input.goal);
  const derived = input.policy ?? contextPolicyFor(signals);
  // Two ceilings, and the lower one wins. `input.tokenBudget` is the caller's
  // hard limit (the configured `ORG_REPO_MAP_TOKENS`, or whatever a test
  // passes); the policy's is what this particular task was judged to need. A
  // policy may ask for less than the ceiling — that is the whole point — but it
  // may never ask for more.
  const ceiling = Math.max(0, input.tokenBudget);
  const policy = {
    ...derived,
    // ...and a floor beneath the narrowing. A policy that judges a task cheap
    // must not be able to shrink an already-small ceiling below the point where
    // even the repository skeleton fits, because the result of that is no
    // context at all — a *worse* outcome than the unselected map, arrived at by
    // an optimization that was supposed to help.
    tokenBudget: Math.max(
      Math.min(derived.tokenBudget, ceiling),
      Math.min(ceiling, MIN_USEFUL_TOKENS),
    ),
  };
  const budgetChars = Math.max(0, Math.floor(policy.tokenBudget)) * CHARS_PER_TOKEN;

  const unique = [...new Map(input.entries.map((entry) => [entry.path, entry])).values()];
  if (budgetChars <= 0 || unique.length === 0) {
    return {
      content: '',
      estimatedTokens: 0,
      receipt: {
        budget: policy.tokenBudget, selectedTokens: 0, selected: [], dropped: unique.map((e) => e.path),
        truncated: false, candidates: 0, confidence: 0, policyVersion: CONTEXT_POLICY_VERSION, structural: true,
      },
    };
  }

  const skeleton = fitSection(
    'Repository shape:',
    skeletonLines(unique),
    Math.floor(budgetChars * SKELETON_SHARE),
  );
  const remainingChars = Math.max(0, budgetChars - skeleton.text.length - (skeleton.text ? 2 : 0));

  const candidates = buildCandidates({
    entries: unique,
    goal: input.goal,
    anchors: extractAnchors(input.goal),
    taskFit: signals,
    previouslySelected: input.previouslySelected,
  });

  const selection = selectContext({
    candidates,
    // The selector budgets in tokens and the skeleton was measured in
    // characters; converting here rather than passing the raw policy keeps the
    // ceiling honest, because what is left after the skeleton is what there is.
    policy: { ...policy, tokenBudget: Math.floor(remainingChars / CHARS_PER_TOKEN) },
    scorer: createContextScorer(),
  });

  const lines = selection.selected.map((candidate) => renderAt(candidate, candidate.selectedLevel));
  const relevant = fitSection('Files this goal points at:', lines, remainingChars);
  const selected = selection.selected.slice(0, relevant.taken).map((candidate) => candidate.path);
  const selectedSet = new Set(selected);
  const content = [skeleton.text, relevant.text].filter(Boolean).join('\n\n');

  return {
    content,
    estimatedTokens: estimateTokens(content),
    receipt: {
      budget: policy.tokenBudget,
      selectedTokens: estimateTokens(content),
      selected,
      dropped: unique.map((entry) => entry.path).filter((path) => !selectedSet.has(path)),
      // Truncated means "something worth taking did not fit" — either the
      // selector said so, or the final render could not take everything the
      // selector chose.
      truncated: selection.truncated || relevant.taken < selection.selected.length,
      candidates: candidates.length,
      confidence: selection.confidence,
      policyVersion: CONTEXT_POLICY_VERSION,
      structural: true,
    },
  };
}

/** The entry point every caller uses. Which planner runs is a deployment
 *  decision, and a planner that throws must cost the dispatch its *planning*,
 *  never its context. */
export function selectDispatchContext(input: DispatchContextInput): DispatchContext {
  if (!contextPlannerEnabled()) return selectLexicalContext(input);
  try {
    return selectStructuralContext(input);
  } catch (err) {
    console.error('The structural context planner failed; falling back to lexical selection:', err);
    return selectLexicalContext(input);
  }
}
