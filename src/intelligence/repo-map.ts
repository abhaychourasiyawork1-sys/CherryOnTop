import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ponytail: regex symbol scan, not a parser. Covers the top-level declarations
// of the languages this repo actually contains; upgrade to web-tree-sitter if a
// benchmark shows the map is too coarse to help.
const SYMBOL = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\(|def|func)\s+([A-Za-z_$][\w$]*)/;
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cts|mts|py|go|rs|java|rb|c|cc|cpp|h|hpp)$/;
const CHARS_PER_TOKEN = 4;

function tracked(worktreePath: string): string[] | null {
  try {
    const out = execFileSync('git', ['ls-files'], { cwd: worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const files = out.split('\n').map((s) => s.trim()).filter(Boolean);
    return files.length > 0 ? files : null;
  } catch {
    return null;
  }
}

function symbolsOf(worktreePath: string, file: string): string[] {
  try {
    const lines = readFileSync(join(worktreePath, file), 'utf8').split('\n');
    const names: string[] = [];
    for (const line of lines) {
      const m = SYMBOL.exec(line);
      if (m?.[1]) names.push(m[1]);
      if (names.length >= 40) break;
    }
    return names;
  } catch {
    return [];
  }
}

/** One tracked file and the top-level symbols in it. The expensive half of a
 *  repository map — a `git ls-files` plus a read of every source file — kept
 *  separate from rendering it, because the same scan now answers two questions:
 *  "show me the repository" and "show me the part of it this goal is about". */
export interface RepoEntry {
  path: string;
  symbols: string[];
}

/** Every tracked file with its symbols, unbudgeted. Empty on any failure, the
 *  same way `buildRepoMap` returns '' — the caller then dispatches the bare
 *  goal, exactly as before. */
export function buildRepoInventory(worktreePath: string): RepoEntry[] {
  const files = tracked(worktreePath);
  if (!files) return [];
  return files.map((path) => ({
    path,
    symbols: SOURCE_EXT.test(path) ? symbolsOf(worktreePath, path) : [],
  }));
}

/** A compact, size-bounded view of the repository handed to a child so it can
 *  navigate instead of grepping from zero. Empty string on any failure — the
 *  caller then dispatches with the bare goal, exactly as before. */
export function buildRepoMap(worktreePath: string, tokenBudget: number): string {
  if (tokenBudget <= 0) return '';
  const entries = buildRepoInventory(worktreePath);
  if (entries.length === 0) return '';
  return renderRepoMap(entries, tokenBudget);
}

/** The whole inventory, rendered down to a budget. Still the fallback whenever
 *  goal-aware selection cannot run: a larger bounded context, never a bare
 *  goal. */
export function renderRepoMap(entries: RepoEntry[], tokenBudget: number): string {
  if (tokenBudget <= 0) return '';
  const files = entries.map((entry) => entry.path);
  const symbolsFor = new Map(entries.map((entry) => [entry.path, entry.symbols]));

  const budgetChars = tokenBudget * CHARS_PER_TOKEN;
  const HEADER = 'Repository files:';
  // A budget too small to even hold the header can't produce a useful map —
  // degrade the same way a failure would rather than emit a fragment that
  // still exceeds the ceiling.
  if (budgetChars < HEADER.length) return '';
  const treeBlock = [HEADER, ...files.map((f) => `  ${f}`)].join('\n');

  if (treeBlock.length >= budgetChars) {
    // Even the tree is over budget: keep whole file lines that fit, and only
    // append the "N more files" marker if it too fits under the ceiling —
    // appending it unconditionally (as a first pass did) could itself push
    // the total past budgetChars.
    const keep: string[] = [];
    let used = HEADER.length;
    let i = 0;
    for (; i < files.length; i++) {
      const line = `  ${files[i]}`;
      if (used + 1 + line.length > budgetChars) break;
      keep.push(line); used += 1 + line.length;
    }
    if (i < files.length) {
      const marker = `  [... ${files.length - i} more files]`;
      if (used + 1 + marker.length <= budgetChars) keep.push(marker);
    }
    return [HEADER, ...keep].join('\n');
  }

  // Budget accounting must include the "Top-level symbols:" header itself —
  // charging only per-line cost let a tiny budget slip the header plus one
  // line past the ceiling.
  const SYMBOLS_HEADER = '\n\nTop-level symbols:\n';
  const symbolLines: string[] = [];
  let used = treeBlock.length;
  for (const f of files) {
    const names = symbolsFor.get(f) ?? [];
    if (names.length === 0) continue;
    const line = `  ${f}: ${names.join(', ')}`;
    const overhead = symbolLines.length === 0 ? SYMBOLS_HEADER.length : 1; // join('\n')
    if (used + overhead + line.length > budgetChars) break;
    symbolLines.push(line); used += overhead + line.length;
  }

  return symbolLines.length > 0
    ? `${treeBlock}${SYMBOLS_HEADER}${symbolLines.join('\n')}`
    : treeBlock;
}

/** Wraps a goal in whatever repository context was selected for it.
 *
 *  The wording matters more than it looks. What follows is now a *selection* —
 *  the files this goal points at, not an inventory — and an agent told "here is
 *  a map of the repository" would reasonably conclude that a file missing from
 *  it does not exist. Saying plainly that the rest of the repository is still
 *  there is what keeps a lossy projection from becoming a wrong answer. */
export function withRepoContext(goal: string, context: string): string {
  if (!context.trim()) return goal;
  return [
    'Repository context, selected for this task. Use it to navigate instead of',
    're-deriving it. It is a starting point, not a complete listing — other files',
    'exist, and you can read anything you need.',
    '',
    context,
    '',
    '---',
    '',
    goal,
  ].join('\n');
}
