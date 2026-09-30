/** What a dispatch's model-visible input is made of, before it is a string.
 *
 *  CherryOnTop owns exactly one model-visible surface per dispatch: the argv it
 *  hands the runtime — a system-prompt channel and a user-message channel (see
 *  docs/superpowers/architecture-decision-records/2026-09-12-runtime-architecture-critique.md).
 *  Everything the agent does after that happens inside a process this code
 *  cannot edit. So the IR describes that surface and nothing more: a list of
 *  typed blocks, each saying which channel it rides, how stable it is across
 *  dispatches, how much it matters, and what cheaper form it can take when the
 *  budget is short.
 *
 *  Pure. No I/O, no clock, no model: the same blocks compile to the same bytes.
 */

/** How long a block's text stays the same, which is what a provider's
 *  prefix cache is keyed on.
 *
 *   - `STATIC`        — identical for every dispatch (the harness constitution).
 *   - `TASK_STABLE`   — identical for every dispatch of one task/commit
 *                       (role stanza, repository context).
 *   - `SESSION_STABLE`— identical across the turns of one conversation or
 *                       handoff (chat history, the parent's envelope).
 *   - `DYNAMIC`       — changes per dispatch or per attempt (the goal itself,
 *                       freshly acquired evidence, a proof-pass instruction).
 *
 *  Declared in this order because the order is the layout: a cacheable prefix
 *  can only be as long as the stable run of blocks at the front. */
export const CACHE_CLASSES = ['STATIC', 'TASK_STABLE', 'SESSION_STABLE', 'DYNAMIC'] as const;
export type CacheClass = typeof CACHE_CLASSES[number];

export function cacheRank(cacheClass: CacheClass): number {
  return CACHE_CLASSES.indexOf(cacheClass);
}

/** Where the runtime takes the text. Two, because that is all a headless agent
 *  CLI offers: `--append-system-prompt` and the prompt argument. */
export type PromptChannel = 'system' | 'user';

export interface PromptBlock {
  /** Unique within a document. What a receipt names. */
  id: string;
  /** Free-form family (`goal`, `repo-context`, `child-report`…) — aggregation
   *  key for the ledger, never interpreted by the compiler. */
  kind: string;
  channel: PromptChannel;
  cacheClass: CacheClass;
  /** Higher survives longer. Only compared between blocks that are both
   *  optional (or both required-and-demotable). */
  priority: number;
  /** A required block is never dropped. It may still shrink through
   *  `fallbacks`, and if it cannot fit at all the compile is refused rather
   *  than silently truncated. */
  required: boolean;
  content: string;
  /** Strictly smaller renderings of the same information, richest first. The
   *  compiler walks down them under pressure. A block with none can only be
   *  kept or (if optional) dropped. */
  fallbacks?: string[];
  /** Blocks sharing a key say the same thing; only one is rendered. */
  dedupeKey?: string;
  /** The canonical owner of what this block projects — a `ContextRef`'s
   *  semantic id, an event id, a path. Provenance for the receipt; the content
   *  is a derived representation of it. */
  sourceRef?: string;
}

export interface PromptDocument {
  blocks: PromptBlock[];
}

export class PromptIrError extends Error {}

/** Separator between rendered blocks. One definition, because the compiled
 *  bytes and every reader of the receipt's offsets must agree on it. */
export const BLOCK_SEPARATOR = '\n\n';

/** Validates the document's shape. Construction errors are programmer errors —
 *  a duplicate id would make the receipt ambiguous — so they throw here rather
 *  than being tolerated downstream. */
export function assertWellFormed(document: PromptDocument): void {
  const seen = new Set<string>();
  for (const block of document.blocks) {
    if (!block.id) throw new PromptIrError('a prompt block needs an id');
    if (seen.has(block.id)) throw new PromptIrError(`duplicate prompt block id: ${block.id}`);
    seen.add(block.id);
    let previous = block.content.length;
    for (const fallback of block.fallbacks ?? []) {
      // A "fallback" that is not smaller would let the demotion loop spin
      // forever while claiming progress.
      if (fallback.length >= previous) {
        throw new PromptIrError(`fallbacks of ${block.id} must each be strictly smaller than the one before`);
      }
      previous = fallback.length;
    }
  }
}

/** Blocks in layout order: channel, then stability, then the order they were
 *  supplied in. Stable so two documents that differ only in a dynamic block
 *  keep an identical stable prefix. */
export function layoutOrder(blocks: PromptBlock[]): PromptBlock[] {
  return blocks
    .map((block, index) => ({ block, index }))
    .sort((a, b) =>
      (a.block.channel === b.block.channel ? 0 : a.block.channel === 'system' ? -1 : 1)
      || cacheRank(a.block.cacheClass) - cacheRank(b.block.cacheClass)
      || a.index - b.index)
    .map(({ block }) => block);
}

/** Keeps one block per `dedupeKey`: the higher priority wins, then the earlier.
 *  Blocks without a key are never merged — two different things that happen to
 *  share text are still two things. */
export function dedupe(blocks: PromptBlock[]): { kept: PromptBlock[]; merged: string[] } {
  const winner = new Map<string, PromptBlock>();
  for (const block of blocks) {
    if (!block.dedupeKey) continue;
    const current = winner.get(block.dedupeKey);
    if (!current || block.priority > current.priority) winner.set(block.dedupeKey, block);
  }
  const merged: string[] = [];
  const kept = blocks.filter((block) => {
    if (!block.dedupeKey) return true;
    if (winner.get(block.dedupeKey) === block) return true;
    merged.push(block.id);
    return false;
  });
  return { kept, merged };
}
