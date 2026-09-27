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

/** How much of a file is on offer. Four explicit levels, cheapest first.
 *
 *   - `L0` — **metadata**: the path alone. Four tokens that can still save a
 *     search, which is why the selector demotes to it rather than dropping.
 *   - `L1` — **structural**: path and top-level symbols.
 *   - `L2` — **focused**: L1 plus the file's direct relationships, so the agent
 *     can navigate outward without a search.
 *   - `L3` — **full artifact**: the file's contents.
 *
 *  L3 is *priced* here and never *materialized* here. That separation is the
 *  point: deciding whether something is worth opening must not cost what opening
 *  it costs. The price comes from `RepoEntry.bytes`, which the inventory scan
 *  already knows because it already read the file; a candidate whose size is
 *  unknown simply does not offer the level, because an unpriceable option
 *  cannot be compared with a priced one. A selector that chooses L3 is making a
 *  *request*, which `context/evidence-actions.ts` fulfils at an execution
 *  boundary. */
export type EvidenceLevel = 'L0' | 'L1' | 'L2' | 'L3';

/** The ladder, cheapest first. One definition, so the selector's escalation and
 *  the candidate's own `evidenceLevel` cannot disagree about the order. */
export const EVIDENCE_LADDER: readonly EvidenceLevel[] = ['L0', 'L1', 'L2', 'L3'];

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
  /** What the whole file would cost, when that is knowable. Absent means the
   *  inventory did not record a size — a binary, a file the scan skipped, a row
   *  cached before sizes were recorded — and an unpriceable level is never
   *  offered. */
  fullArtifactTokens?: number;
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
  /** How evidence up to `L2` is produced. `inventory` means "already in hand,
   *  costs nothing to include". `L3` is always a real read whatever this says —
   *  see `materializationFor`. */
  materialization: 'inventory' | 'read-file';
}

/** How a given level of a given candidate would be produced.
 *
 *  Levels up to L2 render from the inventory already in memory. L3 is a file
 *  read, always, and saying so in one place is what stops a caller assuming a
 *  selection is free because the candidate said `inventory`. */
export function materializationFor(
  candidate: Pick<ContextCandidate, 'materialization'>,
  level: EvidenceLevel,
): 'inventory' | 'read-file' {
  return level === 'L3' ? 'read-file' : candidate.materialization;
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
function confidenceScore(kinds: {
  anchored: boolean; structural: boolean; lexical: number; central?: boolean;
}): number {
  if (kinds.anchored) return 1;
  if (kinds.structural) return 0.7;
  if (kinds.lexical >= PATH_WEIGHT) return 0.5;
  if (kinds.lexical > 0) return 0.3;
  // Centrality is real evidence and weak evidence. "Everything imports this" is
  // a fact about the repository rather than about the goal, so it earns a place
  // in the candidate set and almost no confidence — which is what makes the
  // selector's confidence floor fire and widen, rather than pruning a set it
  // should not be pruning.
  return kinds.central ? CENTRALITY_CONFIDENCE : 0;
}

/** How much a file nothing in the goal points at, but much of the repository
 *  depends on, deserves to be believed. Deliberately below every policy's
 *  confidence floor. */
const CENTRALITY_CONFIDENCE = 0.25;

/** How much of the repository depends on each file, on [0,1].
 *
 *  In-degree over the maximum in-degree. Crude on purpose: this is a tie-break
 *  among files the goal says nothing about, not a claim about importance.
 *
 *  It exists because of a gap the economic layer could not close. Structural
 *  relevance is measured *from anchors* — "what does the compiler tie to the
 *  file the goal named?" — so a goal that names nothing gets no structural
 *  seeds, and a goal with no lexical purchase either gets a candidate set of
 *  almost nothing. Pricing candidates well cannot help when there are no
 *  candidates to price.
 *
 *  Centrality is the one kind of structural evidence that needs no anchor. It
 *  says nothing about the goal and something true about the repository, which
 *  is exactly the right strength of claim for a run that has no idea where to
 *  look: it is better than an alphabetical list and far weaker than an import
 *  edge to a named file. */
function centralityOf(edges: DependencyEdges, entries: RepoEntry[]): Map<string, number> {
  const inDegree = new Map<string, number>();
  let max = 0;
  for (const entry of entries) {
    const count = edges.importedBy.get(entry.path)?.size ?? 0;
    inDegree.set(entry.path, count);
    if (count > max) max = count;
  }
  if (max === 0) return new Map();
  return new Map([...inDegree].map(([path, count]) => [path, count / max]));
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
  // L3 renders as L2 and no further. This module promised never to read a file,
  // and a caller that selected L3 has selected a *request* to be fulfilled at an
  // execution boundary — what it gets in the meantime is the best description
  // available, which is exactly L2.
  return `  ${candidate.path}${symbols}${related}`;
}

/** What handing this candidate over at this level would cost.
 *
 *  L3 is the file itself, priced from the size the inventory recorded. When
 *  that is unknown the level is not on offer, and asking for its price gets the
 *  L2 price rather than an invented one — a caller that also checks
 *  `offersFullArtifact` will not ask, and one that does not must not receive a
 *  guess that understates a whole file. */
export function tokensAt(
  candidate: Pick<ContextCandidate, 'path' | 'symbols' | 'relationships' | 'fullArtifactTokens'>,
  level: EvidenceLevel,
): number {
  if (level === 'L3' && Number.isFinite(candidate.fullArtifactTokens)) {
    return Math.max(estimateTokens(renderAt(candidate, 'L2')), candidate.fullArtifactTokens as number);
  }
  return estimateTokens(renderAt(candidate, level === 'L3' ? 'L2' : level));
}

/** Whether the full-artifact level is genuinely available for this candidate. */
/** Below this a file is a stub (an `__init__.py`, a re-export): its description
 *  already says everything in it. Its reading cost was so small that its net
 *  value came out highest, so it was the file sent in full every time.
 *  ponytail: a size floor stands in for relevance; score the request on the
 *  goal's terms if a small file ever turns out to be the one that mattered. */
export const MIN_FULL_ARTIFACT_TOKENS = 128;

export function offersFullArtifact(candidate: Pick<ContextCandidate, 'fullArtifactTokens'>): boolean {
  return Number.isFinite(candidate.fullArtifactTokens) && (candidate.fullArtifactTokens as number) >= MIN_FULL_ARTIFACT_TOKENS;
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
  // Uncertainty has to widen *generation*, not only selection. The selector
  // already relaxes its marginal test below the confidence floor — but relaxing
  // a test over an empty candidate set changes nothing, which is precisely what
  // happened to a goal naming no file and matching no word.
  //
  // Only when there is nothing anchored: with an anchor in hand, adjacency to it
  // is far better evidence, and mixing centrality in would dilute it.
  const centrality = anchored.size === 0 ? centralityOf(edges, unique) : new Map<string, number>();
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
    const adjacency = isAnchor ? 0 : Math.min(1, relationships.length * 0.5);
    const central = centrality.get(entry.path) ?? 0;
    if (central > 0) relationships.push(`depended-on-by:${edges.importedBy.get(entry.path)?.size ?? 0}`);
    // Adjacency to something named, or — when nothing was named — how much of
    // the repository depends on this. Never both: the second only exists when
    // the first cannot.
    const structural = isAnchor ? 0 : Math.max(adjacency, central);
    if (!isAnchor && structural === 0 && lexical === 0) continue;

    const role = artifactRole(entry.path);
    // L2 buys relationships, and only a file that has some can spend it. L3 is
    // offered whenever the inventory knows the file's size — offering it is not
    // choosing it, and the selector still has to find the increment worth
    // paying for.
    const fullArtifactTokens = Number.isFinite(entry.bytes) && (entry.bytes as number) > 0
      ? Math.ceil((entry.bytes as number) / CHARS_PER_TOKEN)
      : undefined;
    const described: EvidenceLevel = relationships.length > (isAnchor ? 1 : 0) ? 'L2' : 'L1';
    const evidenceLevel: EvidenceLevel = fullArtifactTokens === undefined ? described : 'L3';
    const shape = { path: entry.path, symbols: entry.symbols, relationships, fullArtifactTokens };

    candidates.push({
      key: entry.path,
      path: entry.path,
      symbols: entry.symbols,
      evidenceLevel,
      fullArtifactTokens,
      // What it costs at the level its *description* supports — the cheap,
      // inventory-only view. L3's price is carried separately so that including
      // a candidate never accidentally prices in a file read nobody asked for.
      estimatedTokens: tokensAt(shape, described),
      lexicalScore: lexical,
      structuralScore: isAnchor ? 1 : structural,
      taskFitScore: taskFitScore(role, input.taskFit),
      confidenceScore: confidenceScore({
        anchored: isAnchor,
        // Adjacency to a named file is strong; centrality is not, and calling
        // the second "structural" would launder it into the first.
        structural: adjacency > 0,
        lexical,
        central: central > 0,
      }),
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
