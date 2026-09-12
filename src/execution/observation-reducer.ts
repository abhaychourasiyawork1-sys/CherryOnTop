/** Deterministic reduction of tool output, with the full thing always one ref
 *  away.
 *
 *  Two rules, in this order:
 *
 *   1. **A semantic reducer beats truncation.** The first two thousand
 *      characters of a test log are the tests that passed. Cutting there
 *      produces a shorter output that says strictly less than nothing, because
 *      it looks like the whole answer. Where a reducer for the tool exists, it
 *      runs; truncation is the fallback for output nothing understands.
 *   2. **No model is involved.** This is the "deterministic elimination before
 *      compression" rung. A summarizer in the critical path of every tool call
 *      would cost more than the tokens it saves and add a failure mode to a
 *      path that currently has none.
 */

export interface Reduction {
  text: string;
  /** True when `text` says less than the input did. The signal that expansion
   *  exists and is worth offering. */
  reduced: boolean;
  /** How the reduction was reached, so a reader can tell "we understood this
   *  output" from "we cut it off". */
  strategy: 'none' | 'collapse' | 'semantic' | 'truncate';
  originalLines: number;
  keptLines: number;
}

export function unreduced(text: string): Reduction {
  const lines = text === '' ? 0 : text.split('\n').length;
  return { text, reduced: false, strategy: 'none', originalLines: lines, keptLines: lines };
}

/** Collapses runs of identical lines into one, with a count.
 *
 *  The single highest-yield transform on real shell output: a failing loop, a
 *  progress spinner, a dependency resolver printing the same line per package.
 *  Lossless in meaning — the count preserves what repetition told you. */
export function collapseDuplicates(text: string): { text: string; collapsed: number } {
  const lines = text.split('\n');
  const out: string[] = [];
  let collapsed = 0;
  let i = 0;
  while (i < lines.length) {
    let run = 1;
    while (i + run < lines.length && lines[i + run] === lines[i]) run++;
    out.push(run > 1 ? `${lines[i]}   [× ${run}]` : lines[i]);
    if (run > 1) collapsed += run - 1;
    i += run;
  }
  return { text: out.join('\n'), collapsed };
}

/** Head and tail, with the middle named rather than silently dropped.
 *
 *  The fallback, and deliberately not a plain `slice`: a reader has to be able
 *  to tell that something is missing, or a truncated output reads as a complete
 *  one. */
export function headAndTail(text: string, maxLines: number): Reduction {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return unreduced(text);

  const head = Math.ceil(maxLines * 0.7);
  const tail = maxLines - head;
  const kept = [
    ...lines.slice(0, head),
    `... ${lines.length - maxLines} lines omitted — the full output is kept as an artifact ...`,
    ...lines.slice(lines.length - tail),
  ];
  return {
    text: kept.join('\n'),
    reduced: true,
    strategy: 'truncate',
    originalLines: lines.length,
    keptLines: kept.length,
  };
}

/** Keeps only the lines a matcher recognises as carrying the answer. Used by
 *  the tool projections, which each supply their own matcher. */
export function keepMatching(
  text: string,
  keep: (line: string, index: number, lines: string[]) => boolean,
): Reduction {
  const lines = text.split('\n');
  const kept = lines.filter((line, index) => keep(line, index, lines));
  if (kept.length === 0 || kept.length === lines.length) {
    return kept.length === lines.length ? unreduced(text) : {
      // Nothing matched. Saying so beats returning an empty string, which reads
      // as "the tool produced nothing".
      text: `no lines matched (${lines.length} kept as an artifact)`,
      reduced: true, strategy: 'semantic', originalLines: lines.length, keptLines: 1,
    };
  }
  return {
    text: kept.join('\n'),
    reduced: true,
    strategy: 'semantic',
    originalLines: lines.length,
    keptLines: kept.length,
  };
}

/** Collapse, then bound. The generic path for output no projection claims. */
export function reduceGeneric(text: string, maxLines: number): Reduction {
  const { text: collapsedText, collapsed } = collapseDuplicates(text);
  const bounded = headAndTail(collapsedText, maxLines);
  if (bounded.strategy === 'truncate') {
    return { ...bounded, originalLines: text.split('\n').length };
  }
  if (collapsed === 0) return unreduced(text);
  return {
    text: collapsedText,
    reduced: true,
    strategy: 'collapse',
    originalLines: text.split('\n').length,
    keptLines: collapsedText.split('\n').length,
  };
}
