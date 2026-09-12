/** What changed between one projection of context and the next.
 *
 *  A dispatch that runs twice — the model-fallback retry, a child re-dispatched
 *  after verification failed — resends its whole context the second time,
 *  including the part that did not move. A delta is the part that did.
 *
 *  Four buckets rather than two, because "changed" and "added" call for
 *  different words in a prompt: an agent told a file *changed* knows to re-read
 *  it, while one told it was *added* knows it is new information. Collapsing
 *  them loses the only thing the delta was for. */
import type { ContextRef } from './types.js';

export interface ContextDelta {
  added: ContextRef[];
  removed: ContextRef[];
  /** Same semantic identity, different content. The interesting bucket. */
  changed: { from: ContextRef; to: ContextRef }[];
  unchanged: ContextRef[];
}

export const EMPTY_DELTA: ContextDelta = { added: [], removed: [], changed: [], unchanged: [] };

export function isNoOp(delta: ContextDelta): boolean {
  return delta.added.length === 0 && delta.removed.length === 0 && delta.changed.length === 0;
}

/** How many refs the delta actually mentions. What a caller compares against
 *  the full projection to decide whether sending a delta is worth it — for a
 *  wholesale change, the delta is the projection plus overhead. */
export function deltaSize(delta: ContextDelta): number {
  return delta.added.length + delta.removed.length + delta.changed.length;
}

export function diffProjections(before: ContextRef[], after: ContextRef[]): ContextDelta {
  const beforeById = new Map(before.map((ref) => [ref.semanticId, ref]));
  const afterById = new Map(after.map((ref) => [ref.semanticId, ref]));

  const delta: ContextDelta = { added: [], removed: [], changed: [], unchanged: [] };

  for (const [id, ref] of afterById) {
    const previous = beforeById.get(id);
    if (!previous) delta.added.push(ref);
    else if (previous.contentHash !== ref.contentHash) delta.changed.push({ from: previous, to: ref });
    else delta.unchanged.push(ref);
  }
  for (const [id, ref] of beforeById) {
    if (!afterById.has(id)) delta.removed.push(ref);
  }
  return delta;
}

/** The delta as something a model can act on. Empty string for a no-op: a
 *  paragraph saying nothing changed is worse than saying nothing, because it
 *  costs tokens to communicate an absence. */
export function renderDelta(delta: ContextDelta): string {
  if (isNoOp(delta)) return '';
  const lines: string[] = ['Context changes since your last message:'];
  for (const { to } of delta.changed) lines.push(`  changed: ${to.semanticId} — re-read it, what you were told is out of date`);
  for (const ref of delta.added) lines.push(`  added: ${ref.semanticId}`);
  for (const ref of delta.removed) lines.push(`  no longer relevant: ${ref.semanticId}`);
  return lines.join('\n');
}
