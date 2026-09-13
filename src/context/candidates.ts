/** Everything that could go into a dispatch's context, and what is known about
 *  each one — before anything is chosen and before any file is read.
 *
 *  The selector this replaces asked one question: how many goal words does this
 *  path or symbol contain? That is a real signal and it stays, but on its own it
 *  answers "which files *sound* like the goal", not "which files will the agent
 *  have to open anyway". Those differ exactly where it costs most: a goal naming
 *  one file almost always needs that file's *neighbours* — what it imports, what
 *  imports it, the test that covers it — and lexical scoring finds none of them,
 *  so the agent greps its way there over five turns and pays for the whole
 *  conversation prefix on each.
 *
 *  So a candidate carries four independent kinds of evidence, scored separately
 *  and combined at the policy boundary (`scoring.ts`) rather than here:
 *
 *   - **lexical** — the goal's own words, as before.
 *   - **structural** — real import edges, read off the same scan that already
 *     reads every file. Direct edges only; a neighbour's neighbour is a rumour.
 *   - **task fit** — generic properties of the artifact (is it a test? config?
 *     documentation?) against generic properties of the task. Never a named
 *     file: "high verification need prefers test artifacts" is a rule that
 *     travels to the next repository; "documentation tasks include README.md"
 *     is a lookup table that does not.
 *   - **confidence** — how much the evidence above deserves to be believed.
 *
 *  Nothing here reads a file. Evidence levels describe what *could* be
 *  materialized and what it would cost; deciding whether to look must not cost
 *  what looking costs. */
import type { RepoEntry } from '../intelligence/repo-map.js';

/** How much of a file is on offer.
 *
 *   - `L0` — the path alone.
 *   - `L1` — path and top-level symbols. What the current selector renders.
 *   - `L2` — L1 plus the file's direct relationships, so the agent can navigate
 *     outward without a search.
 *   - `L3` — the file's contents. Never materialized by this module; the level
 *     exists so a selector can say "this one is worth opening" and a caller can
 *     act on it, rather than the question being unaskable. */
export type EvidenceLevel = 'L0' | 'L1' | 'L2' | 'L3';

export interface ContextCandidate {
  /** Stable identity across dispatches on one commit: the path. */
  key: string;
  path: string;
  /** The file's top-level symbols, carried so the cost of every evidence level
   *  is computable from the candidate alone. Without it the selector would have
   *  to hold the inventory too, and the two could disagree about what a line
   *  costs — which is how a budget gets busted by a rounding difference. */
  symbols: string[];
  /** The richest level this candidate has evidence for. The selector may hand
   *  over less when the budget says so; it never invents more. */
  evidenceLevel: EvidenceLevel;
  estimatedTokens: number;
  lexicalScore: number;
  structuralScore: number;
  taskFitScore: number;
  confidenceScore: number;
  reuseScore: number;
  /** Why this file is here at all, in human-readable form: `anchor`,
   *  `imports:src/a.ts`, `imported-by:src/b.ts`, `test-of:src/a.ts`. Rendered
   *  into L2 evidence and into the receipt, so a strange selection can be read
   *  rather than guessed at. */
  relationships: string[];
  /** How the evidence at this level is produced. `inventory` means "already in
   *  hand, costs nothing to include"; `read-file` means a real read, which is
   *  why no L3 candidate is ever produced without being asked for. */
  materialization: 'inventory' | 'read-file';
}

const CHARS_PER_TOKEN = 4;

/** Same tokenization the lexical selector has always used — camelCase split,
 *  lowercased, crude plural folding. Kept identical on purpose: changing how
 *  goals are tokenized changes every selection on every commit, which is a
 *  cache invalidation dressed up as a refactor. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'onto', 'about',
  'all', 'any', 'are', 'but', 'can', 'has', 'have', 'its', 'not', 'out', 'over',
  'should', 'than', 'them', 'then', 'they', 'was', 'were', 'when', 'where',
  'which', 'while', 'will', 'would', 'you', 'your', 'our', 'use', 'using',
  'make', 'made', 'get', 'set', 'run', 'add', 'new', 'old', 'one', 'two',
  'src', 'lib', 'test', 'tests', 'file', 'files', 'code', 'please', 'need',
]);

const PATH_WEIGHT = 2;
const SYMBOL_WEIGHT = 1;

export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function fold(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

export function meaningfulTerms(text: string): Set<string> {
  return new Set(words(text).filter((w) => w.length >= 3 && !STOPWORDS.has(w)).map(fold));
}

function lexicalScore(entry: RepoEntry, goalTerms: Set<string>): number {
  if (goalTerms.size === 0) return 0;
  const pathTerms = new Set(words(entry.path).map(fold));
  const symbolTerms = new Set(entry.symbols.flatMap((s) => words(s)).map(fold));
  let score = 0;
  for (const term of goalTerms) {
    if (pathTerms.has(term)) score += PATH_WEIGHT;
    else if (symbolTerms.has(term)) score += SYMBOL_WEIGHT;
  }
  return score;
}

// ------------------------------------------------------------------ artifacts

/** What kind of artifact a path is, by shape alone. Generic: every one of these
 *  patterns is about how files are named in general, not about this repository.
 *  This is the line the whole design rests on — a rule that travels, rather
 *  than a list that has to be maintained per repo. */
export type ArtifactRole = 'test' | 'config' | 'docs' | 'source';

const TEST_PATH = /(^|\/)(?:tests?|__tests__|spec)\//i;
const TEST_NAME = /\.(?:test|spec)\.[\w]+$/i;
const CONFIG_NAME = /(?:^|\/)(?:[\w.-]*\.config\.[\w]+|package\.json|tsconfig[\w.]*\.json|[\w.-]+\.ya?ml|[\w.-]+\.toml|Dockerfile|Makefile)$/i;
const DOCS_NAME = /\.(?:md|mdx|rst|txt)$/i;

export function artifactRole(path: string): ArtifactRole {
  if (TEST_NAME.test(path) || TEST_PATH.test(path)) return 'test';
  if (DOCS_NAME.test(path)) return 'docs';
  if (CONFIG_NAME.test(path)) return 'config';
  return 'source';
}

/** `src/a/b.test.ts` -> `src/a/b`. The stem two artifacts share when one tests
 *  the other. */
function stem(path: string): string {
  return path.replace(TEST_NAME, '').replace(/\.[\w]+$/, '');
}

// ---------------------------------------------------------------- resolution

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** `src/a/b.ts` + `./c.js` -> `src/a/c`. Path arithmetic only; no filesystem. */
function joinRelative(fromFile: string, specifier: string): string {
  const parts = dirOf(fromFile).split('/').filter(Boolean);
  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

/** The tracked file a relative specifier names, or null.
 *
 *  Handles the two things that actually come up: an extensionless specifier,
 *  and the TypeScript-ESM convention of writing `./x.js` for a file that is
 *  `./x.ts` on disk. A specifier that resolves to nothing is dropped rather
 *  than guessed at — a wrong edge is worse than a missing one, because it
 *  spends the budget on a file with no relationship to the goal at all. */
export function resolveImport(fromFile: string, specifier: string, known: Set<string>): string | null {
  const base = joinRelative(fromFile, specifier);
  const withoutExt = base.replace(/\.[\w]+$/, '');
  const attempts = [
    base,
    ...EXTENSIONS.map((ext) => `${base}${ext}`),
    ...EXTENSIONS.map((ext) => `${withoutExt}${ext}`),
    ...EXTENSIONS.map((ext) => `${base}/index${ext}`),
  ];
  return attempts.find((attempt) => known.has(attempt)) ?? null;
}

export interface DependencyEdges {
  /** path -> the tracked files it imports. */
  imports: Map<string, Set<string>>;
  /** path -> the tracked files that import it. */
  importedBy: Map<string, Set<string>>;
}

function addEdge(map: Map<string, Set<string>>, from: string, to: string): void {
  const set = map.get(from) ?? new Set<string>();
  set.add(to);
  map.set(from, set);
}

/** The repository's direct import graph, from the specifiers the scan recorded.
 *
 *  Built fresh per selection rather than cached: it is a few map inserts over an
 *  inventory that is already in memory, and a second cache keyed on the same
 *  HEAD would be a second thing to invalidate for no measurable saving. */
export function buildDependencyEdges(entries: RepoEntry[]): DependencyEdges {
  const known = new Set(entries.map((e) => e.path));
  const edges: DependencyEdges = { imports: new Map(), importedBy: new Map() };
  for (const entry of entries) {
    for (const specifier of entry.imports ?? []) {
      const target = resolveImport(entry.path, specifier, known);
      if (!target || target === entry.path) continue;
      addEdge(edges.imports, entry.path, target);
      addEdge(edges.importedBy, target, entry.path);
    }
  }
  return edges;
}

// ---------------------------------------------------------------- candidates

export interface CandidateInput {
  entries: RepoEntry[];
  goal: string;
  /** What the goal named outright. An anchor is the strongest evidence there
   *  is, because the person writing the goal put it there. */
  anchors: string[];
  /** Generic properties of the task. Only ever used to weigh artifact *kinds*,
   *  never to name a file. */
  taskFit: {
    verificationNeed: number;
    investigationLikelihood: number;
    readOnly: boolean;
  };
  /** Paths a sibling dispatch on this same commit already received. Selecting
   *  them again keeps the prompt prefix identical, which is what the provider's
   *  cache is keyed on — so reuse here is a real saving, not a tidiness. */
  previouslySelected?: Iterable<string>;
}

/** How much a file's own kind fits the task's shape. Generic on both sides. */
function taskFitScore(role: ArtifactRole, fit: CandidateInput['taskFit']): number {
  if (role === 'test') return fit.verificationNeed;
  if (role === 'docs') return fit.investigationLikelihood * 0.5;
  if (role === 'config') return fit.readOnly ? 0.2 : 0.35;
  return 0.5;
}

/** Strong evidence is evidence a person put there or the compiler enforces.
 *  A lexical brush-past is neither. */
function confidenceScore(kinds: { anchored: boolean; structural: boolean; lexical: number }): number {
  if (kinds.anchored) return 1;
  if (kinds.structural) return 0.7;
  if (kinds.lexical >= PATH_WEIGHT) return 0.5;
  return kinds.lexical > 0 ? 0.3 : 0;
}

/** The one place that knows how a candidate becomes text, so the selector's
 *  token arithmetic and the renderer can never disagree about what a line
 *  costs. `L3` is not rendered here: it is a whole file, which this module has
 *  promised never to read. */
export function renderAt(
  candidate: Pick<ContextCandidate, 'path' | 'symbols' | 'relationships'>,
  level: EvidenceLevel,
): string {
  if (level === 'L0') return `  ${candidate.path}`;
  const symbols = candidate.symbols.length > 0 ? `: ${candidate.symbols.join(', ')}` : '';
  if (level === 'L1') return `  ${candidate.path}${symbols}`;
  const related = candidate.relationships.length > 0 ? ` [${candidate.relationships.join(', ')}]` : '';
  return `  ${candidate.path}${symbols}${related}`;
}

export function tokensAt(
  candidate: Pick<ContextCandidate, 'path' | 'symbols' | 'relationships'>,
  level: EvidenceLevel,
): number {
  return estimateTokens(renderAt(candidate, level));
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Does this path answer to this anchor? Suffix-matched, so a goal saying
 *  `session.ts` finds `src/auth/session.ts`, and a goal saying the whole path
 *  finds only that. Symbol anchors match the file that declares them. */
function anchorHit(entry: RepoEntry, anchors: string[]): boolean {
  return anchors.some((anchor) => {
    if (anchor.includes('/') || anchor.includes('.')) {
      return entry.path === anchor || entry.path.endsWith(`/${anchor}`);
    }
    return entry.symbols.includes(anchor);
  });
}

/** Every file with any evidence tying it to the goal, unranked and unbudgeted.
 *
 *  A file with no evidence at all is not a candidate: it would only ever be
 *  used to top the budget up towards its ceiling, and a budget treated as a
 *  target is the thing this whole subsystem exists to stop. */
export function buildCandidates(input: CandidateInput): ContextCandidate[] {
  const unique = [...new Map(input.entries.map((e) => [e.path, e])).values()];
  const edges = buildDependencyEdges(unique);
  const goalTerms = meaningfulTerms(input.goal);
  const reused = new Set(input.previouslySelected ?? []);

  // Anchored files first — they are the seeds every structural relationship is
  // measured from. A relationship to nothing in particular is not a
  // relationship.
  const anchored = new Set(unique.filter((e) => anchorHit(e, input.anchors)).map((e) => e.path));
  const byStem = new Map<string, string[]>();
  for (const entry of unique) {
    const key = stem(entry.path);
    byStem.set(key, [...(byStem.get(key) ?? []), entry.path]);
  }

  const candidates: ContextCandidate[] = [];
  for (const entry of unique) {
    const isAnchor = anchored.has(entry.path);
    const relationships: string[] = [];
    if (isAnchor) relationships.push('anchor');

    // Direct edges to an anchored file, in both directions. Only direct: a
    // dependency of a dependency is two guesses stacked, and the budget it
    // would spend is better given to something the goal actually named.
    for (const target of edges.imports.get(entry.path) ?? []) {
      if (anchored.has(target)) relationships.push(`imports:${target}`);
    }
    for (const source of edges.importedBy.get(entry.path) ?? []) {
      if (anchored.has(source)) relationships.push(`imported-by:${source}`);
    }
    // The test that covers an anchored file, and the file an anchored test
    // covers. Deterministic from the naming convention, and the single most
    // reliably-needed neighbour there is: work that changes code changes its
    // test, and neither import edges nor lexical matching finds it.
    for (const sibling of byStem.get(stem(entry.path)) ?? []) {
      if (sibling === entry.path || !anchored.has(sibling)) continue;
      relationships.push(artifactRole(entry.path) === 'test' ? `test-of:${sibling}` : `tested-by:${sibling}`);
    }

    const lexical = lexicalScore(entry, goalTerms);
    const structural = isAnchor ? 0 : Math.min(1, relationships.length * 0.5);
    if (!isAnchor && structural === 0 && lexical === 0) continue;

    const role = artifactRole(entry.path);
    // L2 buys relationships, and only a file that has some can spend it.
    const evidenceLevel: EvidenceLevel = relationships.length > (isAnchor ? 1 : 0) ? 'L2' : 'L1';
    const shape = { path: entry.path, symbols: entry.symbols, relationships };

    candidates.push({
      key: entry.path,
      path: entry.path,
      symbols: entry.symbols,
      evidenceLevel,
      estimatedTokens: tokensAt(shape, evidenceLevel),
      lexicalScore: lexical,
      structuralScore: isAnchor ? 1 : structural,
      taskFitScore: taskFitScore(role, input.taskFit),
      confidenceScore: confidenceScore({ anchored: isAnchor, structural: structural > 0, lexical }),
      reuseScore: reused.has(entry.path) ? 1 : 0,
      relationships,
      materialization: 'inventory',
    });
  }

  // Path as the final tie-break, so the same goal against the same tree always
  // produces the same list in the same order — which is what makes the rendered
  // result safe to cache across the siblings sitting on one commit.
  return candidates.sort((a, b) =>
    b.confidenceScore - a.confidenceScore
    || b.structuralScore - a.structuralScore
    || b.lexicalScore - a.lexicalScore
    || (a.path < b.path ? -1 : 1));
}
