/** Getting the part of a file a decision needs, and saying plainly that it is
 *  only a part.
 *
 *  Pure string functions over content already in hand; no I/O and no parser
 *  dependency. A parser was the obvious answer and is not needed for the case
 *  that pays: a symbol the goal named, in a language whose declarations are
 *  delimited by braces, indentation or `end`. Those are three small scanners.
 *  Anything they cannot delimit with confidence returns `null`, and the caller
 *  escalates to the next representation up — the whole file, which is bounded —
 *  because the one thing worse than sending too much is sending a confident
 *  wrong excerpt.
 *
 *  Two rules apply throughout:
 *   - **Never fabricate a boundary.** An unbalanced brace, an unterminated
 *     block, a body past `MAX_SYMBOL_LINES`: no excerpt.
 *   - **An excerpt says it is one.** `describeExcerpt` states the line range,
 *     the total, and that the rest of the file was not sent. An agent handed a
 *     fragment that does not announce itself believes it has read the file.
 */

/** The largest declaration worth calling an excerpt. Past this, the excerpt is
 *  most of a small file and the honest representation is the file. */
export const MAX_SYMBOL_LINES = 300;

/** Lines of doc comment or decorator carried with a declaration. */
const LEADING_LINES = 12;

export interface Excerpt {
  /** 1-based, inclusive. */
  from: number;
  to: number;
  text: string;
  totalLines: number;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The declaration line for `name`: the same shapes `repo-map.ts` recognises as
 *  a symbol, anchored so a call site, a comment or a longer identifier that
 *  merely contains the name does not match. */
function declarationPattern(name: string): RegExp {
  const id = escapeRegExp(name);
  return new RegExp(
    `^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?` +
    `(?:function\\*?|class|interface|type|enum|def|func|fn|const|let|var)\\s+${id}(?![\\w$])`,
  );
}

function leadingStart(lines: string[], declLine: number): number {
  let start = declLine;
  while (start > 0 && declLine - start < LEADING_LINES && /^\s*(?:\/\/|\/\*|\*|@|#(?!\s*include)|""")/.test(lines[start - 1])) start--;
  return start;
}

/** Index (in lines) of the line where a brace-delimited declaration ends, or
 *  null. Skips strings, template literals and both comment styles; only braces
 *  at parenthesis depth zero open the body. */
function braceEnd(lines: string[], declLine: number): number | null {
  let paren = 0;
  let depth = 0;
  let opened = false;
  let inBlockComment = false;
  let quote: string | null = null;

  for (let i = declLine; i < lines.length; i++) {
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      const next = line[j + 1];
      if (inBlockComment) { if (c === '*' && next === '/') { inBlockComment = false; j++; } continue; }
      if (quote) {
        if (c === '\\') { j++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '/' && next === '*') { inBlockComment = true; j++; continue; }
      if (c === '/' && next === '/') break;
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (c === '(' || c === '[') paren++;
      else if (c === ')' || c === ']') paren = Math.max(0, paren - 1);
      else if (c === '{' && paren === 0) { depth++; opened = true; }
      else if (c === '}' && opened) {
        depth--;
        if (depth === 0) {
          // A `}` closing a return-type literal is followed by the real body.
          const rest = line.slice(j + 1).trimStart();
          if (rest.startsWith('{') || rest.startsWith('=>')) continue;
          return i;
        }
      } else if (c === ';' && !opened && paren === 0) {
        return i; // a one-line declaration with no body
      }
    }
    // A quote never legitimately spans lines, except a template literal.
    if (quote && quote !== '`') quote = null;
    if (i - declLine > MAX_SYMBOL_LINES) return null;
    // An arrow function with an expression body and no semicolon.
    if (!opened && paren === 0 && i > declLine && !/[=,(&|+\-*/?:]\s*$/.test(lines[i - 1] ?? '')) {
      return i - 1;
    }
  }
  return null;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Python-style: the block is every following line indented deeper than the
 *  declaration, blank lines included, up to the first line that is not. */
function indentEnd(lines: string[], declLine: number): number | null {
  const base = indentOf(lines[declLine]);
  let end = declLine;
  for (let i = declLine + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (indentOf(lines[i]) <= base) break;
    end = i;
  }
  return end > declLine ? end : null;
}

/** Ruby-style: through the `end` at the declaration's own indentation. */
function keywordEnd(lines: string[], declLine: number): number | null {
  const base = indentOf(lines[declLine]);
  for (let i = declLine + 1; i < lines.length; i++) {
    if (indentOf(lines[i]) === base && /^\s*end\b/.test(lines[i])) return i;
  }
  return null;
}

/** The body of the first declaration of `name`, with the comment block above it,
 *  or null when it cannot be delimited with confidence. */
export function findSymbolBody(content: string, name: string): Excerpt | null {
  if (!name) return null;
  const lines = content.split('\n');
  const pattern = declarationPattern(name);
  const declLine = lines.findIndex((line) => pattern.test(line));
  if (declLine === -1) return null;

  const declaration = lines[declLine].trim();
  const isDef = /^(?:async\s+)?def\s/.test(declaration);
  let end: number | null;
  if (isDef && /:\s*(?:#.*)?$/.test(declaration)) end = indentEnd(lines, declLine);
  else if (isDef && !declaration.includes('{')) end = keywordEnd(lines, declLine);
  else end = braceEnd(lines, declLine);

  if (end === null) return null;
  const start = leadingStart(lines, declLine);
  if (end - start + 1 > MAX_SYMBOL_LINES) return null;
  return { from: start + 1, to: end + 1, text: lines.slice(start, end + 1).join('\n'), totalLines: lines.length };
}

/** An inclusive 1-based line range, clamped to the file. Null when nothing of
 *  the range exists. */
export function extractLines(content: string, from: number, to: number): Excerpt | null {
  const lines = content.split('\n');
  const start = Math.max(1, Math.floor(from));
  const end = Math.min(lines.length, Math.floor(to));
  if (start > end) return null;
  return { from: start, to: end, text: lines.slice(start - 1, end).join('\n'), totalLines: lines.length };
}

/** How an excerpt is introduced to the agent. */
export function describeExcerpt(path: string, excerpt: Excerpt, label?: string): string {
  const what = label ? `\`${label}\` in ${path}` : path;
  return `${what} — lines ${excerpt.from}-${excerpt.to} of ${excerpt.totalLines}. This is only part of the file: the rest of the file was not sent, so read it if you need more.`;
}
