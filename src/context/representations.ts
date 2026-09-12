/** The cheapest sufficient way to say what an object says.
 *
 *  A projection's real question is never "include this or not" — it is "how
 *  much of this". A file can enter a prompt as a path, as its exported
 *  signatures, as forty lines, or as four thousand, and the difference between
 *  the first and the last is three orders of magnitude of budget for the same
 *  fact. Materializing the full thing by default is how a budget becomes a
 *  target.
 *
 *  Two rules:
 *
 *   - **Cheapest first.** `cheapestSufficient` walks up from `reference`, not
 *     down from `full`.
 *   - **Never fabricate.** A representation that cannot be derived returns a
 *     structured refusal naming what *is* available. Inventing a summary of
 *     content we could not read is the one failure mode worse than sending too
 *     much.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { events, artifacts } from '../db/schema.js';
import type { ContextObject } from './types.js';

/** Ordered cheapest to most expensive. The order is the policy. */
export const REPRESENTATIONS = [
  'reference', 'metadata', 'signature', 'summary', 'snippet', 'hunk', 'full',
] as const;

export type Representation = typeof REPRESENTATIONS[number];

export function representationRank(representation: Representation): number {
  return REPRESENTATIONS.indexOf(representation);
}

const CHARS_PER_TOKEN = 4;
const SNIPPET_LINES = 40;
const SUMMARY_LINES = 8;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** The bytes an object is about, or null when they cannot be read.
 *
 *  Null is a real answer here — an artifact whose row was pruned, a file deleted
 *  since it was observed — and the caller must degrade rather than invent. */
export function resolveContent(db: Db, object: ContextObject, worktreePath?: string): string | null {
  try {
    switch (object.source.kind) {
      case 'inline':
        return object.inline ?? null;
      case 'repo': {
        if (!worktreePath) return null;
        return readFileSync(join(worktreePath, object.source.locator), 'utf8');
      }
      case 'event': {
        const row = db.select().from(events).where(eq(events.id, Number(object.source.locator))).all()[0];
        return row ? JSON.stringify(row.payload) : null;
      }
      case 'artifact': {
        const row = db.select().from(artifacts).where(eq(artifacts.id, object.source.locator)).all()[0];
        return row ? row.summary : null;
      }
    }
  } catch {
    return null;
  }
}

/** Exported top-level names. The same regex `repo-map.ts` scans with — one
 *  definition of "what counts as a symbol here", not two that can disagree. */
const SYMBOL = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\(|def|func)\s+([A-Za-z_$][\w$]*)/;

function signatureOf(content: string): string[] {
  const names: string[] = [];
  for (const line of content.split('\n')) {
    const match = SYMBOL.exec(line);
    if (match?.[1]) names.push(match[1]);
    if (names.length >= 40) break;
  }
  return names;
}

export interface MaterializedContext {
  representation: Representation;
  content: string;
  tokens: number;
  /** True when the representation is a bounded view of something larger — which
   *  is every representation below `full`. The signal that expansion exists. */
  partial: boolean;
}

export interface RepresentationRefusal {
  refused: true;
  reason: string;
  /** What could be produced instead. A refusal that does not say what *is*
   *  possible just moves the problem. */
  available: Representation[];
}

export type MaterializeResult = MaterializedContext | RepresentationRefusal;

export function isRefusal(result: MaterializeResult): result is RepresentationRefusal {
  return (result as RepresentationRefusal).refused === true;
}

/** Which representations this object can actually produce.
 *
 *  `reference` and `metadata` need nothing but the object itself, which is why
 *  a projection can always fall back to them rather than to nothing. */
export function availableRepresentations(content: string | null): Representation[] {
  if (content === null) return ['reference', 'metadata'];
  const available: Representation[] = ['reference', 'metadata', 'summary', 'snippet', 'hunk', 'full'];
  if (signatureOf(content).length > 0) available.splice(2, 0, 'signature');
  return available;
}

export interface MaterializeOptions {
  /** Hard ceiling in tokens. A representation that cannot fit is refused rather
   *  than truncated into something that still busts the budget. */
  tokenBudget?: number;
  /** For `hunk`: the 1-based, inclusive line range. */
  lines?: { from: number; to: number };
  worktreePath?: string;
}

function render(
  object: ContextObject,
  representation: Representation,
  content: string | null,
  options: MaterializeOptions,
): string | null {
  switch (representation) {
    case 'reference':
      return object.ref.semanticId;
    case 'metadata':
      return `${object.ref.semanticId} (${object.kind}, ~${object.tokens} tokens, ${object.freshness.toLowerCase()})`;
    case 'signature': {
      if (content === null) return null;
      const names = signatureOf(content);
      return names.length > 0 ? `${object.ref.semanticId}: ${names.join(', ')}` : null;
    }
    case 'summary':
      return content === null ? null : content.split('\n').slice(0, SUMMARY_LINES).join('\n');
    case 'snippet':
      return content === null ? null : content.split('\n').slice(0, SNIPPET_LINES).join('\n');
    case 'hunk': {
      if (content === null || !options.lines) return null;
      const lines = content.split('\n');
      const from = Math.max(1, options.lines.from);
      const to = Math.min(lines.length, options.lines.to);
      return from > to ? null : lines.slice(from - 1, to).join('\n');
    }
    case 'full':
      return content;
  }
}

export function materialize(
  db: Db,
  object: ContextObject,
  representation: Representation,
  options: MaterializeOptions = {},
): MaterializeResult {
  const content = resolveContent(db, object, options.worktreePath);
  const available = availableRepresentations(content);
  const text = render(object, representation, content, options);

  if (text === null) {
    return {
      refused: true,
      available,
      reason: content === null
        ? `the content behind ${object.ref.semanticId} could not be read`
        : `${representation} cannot be derived from ${object.ref.semanticId}`,
    };
  }

  const tokens = estimateTokens(text);
  if (options.tokenBudget !== undefined && tokens > options.tokenBudget) {
    return {
      refused: true,
      available: available.filter((r) => representationRank(r) < representationRank(representation)),
      reason: `${representation} of ${object.ref.semanticId} needs ~${tokens} tokens, budget is ${options.tokenBudget}`,
    };
  }

  return { representation, content: text, tokens, partial: representation !== 'full' };
}

/** The cheapest representation at or above `atLeast` that fits the budget.
 *
 *  Walks *up* from the cheapest rather than down from `full`: starting at full
 *  and shrinking is how a budget becomes a target, because the first thing that
 *  fits is always the largest thing that fits. */
export function cheapestSufficient(
  db: Db,
  object: ContextObject,
  options: MaterializeOptions & { atLeast?: Representation } = {},
): MaterializeResult {
  const floor = representationRank(options.atLeast ?? 'reference');
  const content = resolveContent(db, object, options.worktreePath);
  const available = availableRepresentations(content);

  let best: MaterializedContext | null = null;
  for (const representation of REPRESENTATIONS) {
    if (representationRank(representation) < floor) continue;
    if (!available.includes(representation)) continue;
    const result = materialize(db, object, representation, options);
    if (isRefusal(result)) continue;
    // The most informative thing that still fits — but only ever considered in
    // ascending order, so nothing larger than the budget is ever built.
    best = result;
  }

  return best ?? {
    refused: true,
    available,
    reason: `nothing at or above ${options.atLeast ?? 'reference'} fits a budget of ${options.tokenBudget ?? 'unbounded'}`,
  };
}
