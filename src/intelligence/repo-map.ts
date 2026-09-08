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

/** A compact, size-bounded view of the repository handed to a child so it can
 *  navigate instead of grepping from zero. Empty string on any failure — the
 *  caller then dispatches with the bare goal, exactly as before. */
export function buildRepoMap(worktreePath: string, tokenBudget: number): string {
  if (tokenBudget <= 0) return '';
  const files = tracked(worktreePath);
  if (!files) return '';

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
    if (!SOURCE_EXT.test(f)) continue;
    const names = symbolsOf(worktreePath, f);
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

export function withRepoMap(goal: string, map: string): string {
  if (!map.trim()) return goal;
  return [
    'Here is a map of the repository you are working in. Use it to navigate;',
    'do not re-derive it.',
    '',
    map,
    '',
    '---',
    '',
    goal,
  ].join('\n');
}
