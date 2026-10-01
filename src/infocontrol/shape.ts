/** The representations an observation can enter the conversation in.
 *
 *  The ladder, cheapest last: `full` (as the tool returned it) → `salient`
 *  (head and tail kept whole, the middle reduced to the lines most related to
 *  the task, repetition collapsed) → `outline` (a source file's declarations
 *  with their line numbers) → `pointer` (one line and where the rest is).
 *
 *  Every reduced form ends with a footer saying what was left out and exactly
 *  how to get it back, so an elision is always undoable by one ordinary tool
 *  call. Nothing here decides which rung to use; `policy.ts` prices them.
 *
 *  Structural and lexical only. Salience is an IDF-weighted overlap between a
 *  line and the task's own words plus the agent's own query, computed from the
 *  output itself: an information-retrieval score, not a keyword rule. */
import { estimateTokens } from '../context/candidates.js';
import { SYMBOL } from '../context/representations.js';

export type Representation = 'full' | 'salient' | 'outline' | 'pointer';

export interface ShapedCandidate {
  representation: Representation;
  text: string;
  tokens: number;
}

/** The text a tool returned, from the shapes Claude Code reports. `null` when
 *  the shape is not one we know: an unknown shape is passed through untouched. */
export function extractText(response: unknown): string | null {
  if (typeof response === 'string') return response;
  if (Array.isArray(response)) {
    const parts = response.map((part) => extractText(part));
    return parts.every((p) => p !== null) ? parts.join('\n') : null;
  }
  if (typeof response !== 'object' || response === null) return null;
  const r = response as Record<string, unknown>;
  if (r.is_error === true) return null;
  if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
    const out = typeof r.stdout === 'string' ? r.stdout : '';
    const err = typeof r.stderr === 'string' ? r.stderr : '';
    return err ? (out ? `${out}\n${err}` : err) : out;
  }
  if (typeof r.text === 'string') return r.text;
  const file = r.file as Record<string, unknown> | undefined;
  if (file && typeof file.content === 'string') return file.content;
  if (typeof r.content === 'string') return r.content;
  if (Array.isArray(r.filenames)) return r.filenames.join('\n');
  if (typeof r.result === 'string') return r.result;
  return null;
}

const TERM = /[A-Za-z_][A-Za-z0-9_]{2,}/g;

export function termsOf(text: string): Set<string> {
  return new Set((text.match(TERM) ?? []).map((t) => t.toLowerCase()));
}

/** Code-shaped identifiers (an underscore, a digit, or an internal capital in
 *  the original case; six characters or more), lowercased. What counts as
 *  evidence that a region held something specific: plain words do not. */
export function codeIdentifiers(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.match(/[A-Za-z_][A-Za-z0-9_]{5,}/g) ?? []) {
    if (/_|\d|[a-z][A-Z]/.test(t)) out.add(t.toLowerCase());
  }
  return out;
}

/** Per-line salience: sum over query terms present of log(lines / lines containing it). */
export function salience(lines: readonly string[], query: ReadonlySet<string>): number[] {
  const perLine = lines.map((l) => termsOf(l));
  const df = new Map<string, number>();
  for (const terms of perLine) for (const t of terms) if (query.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = lines.length;
  return perLine.map((terms) => {
    let s = 0;
    for (const t of terms) {
      const d = df.get(t);
      if (d) s += Math.log((n + 1) / d);
    }
    return s;
  });
}

/** Runs of lines that differ only in their digits (progress bars, download
 *  ticks, repeated warnings) folded to their first line and a count. */
export function collapseRepeats(lines: readonly string[]): { lines: string[]; origin: number[] } {
  const out: string[] = [];
  const origin: number[] = [];
  const key = (s: string) => s.replace(/\d+/g, '#').trim();
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && key(lines[j]) === key(lines[i])) j++;
    if (j - i >= 4) {
      // First and last kept: the last tick of a progress bar or the last of a
      // repeated error is usually the informative one.
      out.push(lines[i], `  … (${j - i - 2} similar lines) …`, lines[j - 1]);
      origin.push(i, i + 1, j - 1);
    } else {
      for (let k = i; k < j; k++) { out.push(lines[k]); origin.push(k); }
    }
    i = j;
  }
  return { lines: out, origin };
}

export function footer(kept: number, total: number, keptTokens: number, totalTokens: number, locator: string): string {
  return `\n[information control: showing ${kept} of ${total} lines (~${keptTokens} of ~${totalTokens} tokens). `
    + `The complete output is in ${locator} — Read it (with offset/limit for a range) if you need what was left out.]`;
}

/** Head, tail and the most task-related middle lines, within `budgetLines`. */
export function salientView(text: string, query: ReadonlySet<string>, budgetLines: number, locator: string): string | null {
  const raw = text.split('\n');
  const { lines, origin } = collapseRepeats(raw);
  if (lines.length <= budgetLines) {
    return lines.length < raw.length ? lines.join('\n') + footer(lines.length, raw.length, estimateTokens(lines.join('\n')), estimateTokens(text), locator) : null;
  }
  const edge = Math.max(1, Math.ceil(budgetLines * 0.35));
  const keep = new Set<number>();
  for (let i = 0; i < edge; i++) keep.add(i);
  for (let i = lines.length - edge; i < lines.length; i++) keep.add(i);
  const scores = salience(lines, query);
  const middle = [...scores.keys()].filter((i) => !keep.has(i) && scores[i] > 0).sort((a, b) => scores[b] - scores[a] || a - b);
  for (const i of middle.slice(0, Math.max(0, budgetLines - keep.size))) keep.add(i);
  const out: string[] = [];
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > last + 1) out.push(`… [lines ${origin[last + 1] + 1}–${origin[i]} omitted] …`);
    out.push(lines[i]);
    last = i;
  }
  const body = out.join('\n');
  return body + footer(keep.size, raw.length, estimateTokens(body), estimateTokens(text), locator);
}

/** A source file's declarations with their line numbers, plus its first lines. */
export function outlineView(text: string, locator: string): string | null {
  const lines = text.split('\n');
  const decls: string[] = [];
  lines.forEach((line, i) => {
    // Read output carries a `   12\t` line-number prefix; match the code after it.
    const code = line.replace(/^\s*\d+\t/, '');
    if (SYMBOL.test(code)) decls.push(line.includes('\t') ? line : `${i + 1}: ${line}`);
  });
  if (decls.length === 0) return null;
  const head = lines.slice(0, Math.min(10, lines.length));
  const body = [...head, '… declarations:', ...decls].join('\n');
  return body + footer(head.length + decls.length, lines.length, estimateTokens(body), estimateTokens(text), locator);
}

export function pointerView(text: string, locator: string): string {
  const lines = text.split('\n');
  const first = lines.find((l) => l.trim()) ?? '';
  const body = first.slice(0, 200);
  return body + footer(1, lines.length, estimateTokens(body), estimateTokens(text), locator);
}

export interface CandidateInput {
  text: string;
  query: ReadonlySet<string>;
  locator: string;
  /** Source files get an outline rung; logs and listings do not. */
  source: boolean;
}

/** Every reduced representation that is actually smaller than the original. */
export function shapeCandidates(input: CandidateInput): ShapedCandidate[] {
  const full = estimateTokens(input.text);
  const lines = input.text.split('\n').length;
  const views: Array<[Representation, string | null]> = [
    ['salient', salientView(input.text, input.query, Math.max(12, Math.ceil(lines * 0.2)), input.locator)],
    ['salient', salientView(input.text, input.query, Math.max(8, Math.ceil(lines * 0.06)), input.locator)],
    ['outline', input.source ? outlineView(input.text, input.locator) : null],
    ['pointer', pointerView(input.text, input.locator)],
  ];
  const out: ShapedCandidate[] = [];
  for (const [representation, text] of views) {
    if (text === null) continue;
    const tokens = estimateTokens(text);
    if (tokens < full && !out.some((c) => c.text === text)) out.push({ representation, text, tokens });
  }
  return out;
}
