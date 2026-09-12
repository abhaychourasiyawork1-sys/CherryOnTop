/** What the organization knows, does not know, and has decided it does not need
 *  to know.
 *
 *  The third bucket is the one that matters. "Unknown" grows without bound in
 *  any real repository, so a planner that only tracks known-versus-unknown never
 *  stops looking. Recording that something was *considered and ruled out* is
 *  what lets evidence gathering terminate — and terminating is the whole saving.
 *
 *  Pure and serializable: a frontier is carried in a receipt, not held in a
 *  process. */
import type { ContextRef } from './types.js';

export interface KnowledgeFrontier {
  known: ContextRef[];
  unknown: ContextRef[];
  unnecessary: ContextRef[];
}

export const EMPTY_FRONTIER: KnowledgeFrontier = { known: [], unknown: [], unnecessary: [] };

const keyOf = (ref: ContextRef): string => `${ref.semanticId}\0${ref.contentHash}`;

function without(refs: ContextRef[], remove: Set<string>): ContextRef[] {
  return refs.filter((ref) => !remove.has(keyOf(ref)));
}

function add(refs: ContextRef[], incoming: ContextRef[]): ContextRef[] {
  const seen = new Set(refs.map(keyOf));
  return [...refs, ...incoming.filter((ref) => !seen.has(keyOf(ref)) && (seen.add(keyOf(ref)), true))];
}

export interface FrontierUpdate {
  /** Refs the latest observation actually taught us. */
  learned?: ContextRef[];
  /** Refs it revealed we still need. */
  raised?: ContextRef[];
  /** Refs it showed are not worth looking at. */
  ruledOut?: ContextRef[];
}

/** Applies one observation. A ref can only be in one bucket: learning something
 *  removes it from unknown, ruling it out removes it from both. */
export function updateFrontier(frontier: KnowledgeFrontier, update: FrontierUpdate): KnowledgeFrontier {
  const learned = update.learned ?? [];
  const raised = update.raised ?? [];
  const ruledOut = update.ruledOut ?? [];

  const learnedKeys = new Set(learned.map(keyOf));
  const ruledKeys = new Set(ruledOut.map(keyOf));

  const known = without(add(frontier.known, learned), ruledKeys);
  const unnecessary = add(without(frontier.unnecessary, learnedKeys), ruledOut);

  // A ref cannot be outstanding if we already know it or have ruled it out —
  // that is how an evidence loop re-asks a closed question forever.
  const settled = new Set([...known.map(keyOf), ...unnecessary.map(keyOf)]);
  const unknown = add(frontier.unknown, raised).filter((ref) => !settled.has(keyOf(ref)));

  return { known, unknown, unnecessary };
}

/** Nothing outstanding. The condition an evidence planner stops on. */
export function isClosed(frontier: KnowledgeFrontier): boolean {
  return frontier.unknown.length === 0;
}

/** How much of what was ever considered is settled. Reported rather than acted
 *  on: a planner that optimized this number would close the frontier by ruling
 *  everything out. */
export function closure(frontier: KnowledgeFrontier): number {
  const total = frontier.known.length + frontier.unknown.length + frontier.unnecessary.length;
  return total === 0 ? 1 : (frontier.known.length + frontier.unnecessary.length) / total;
}
