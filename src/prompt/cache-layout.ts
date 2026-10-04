/** Where a provider's prefix cache can and cannot help.
 *
 *  A prompt cache is keyed on a prefix: identical leading bytes are read at a
 *  fraction of the fresh-input price, and the first differing byte ends the
 *  reuse. So the only layout decision that matters is which text leads. Text
 *  that is the same across dispatches goes first; text that differs — the goal,
 *  freshly acquired evidence, a proof-pass instruction — goes last, and nothing
 *  correctness-critical is made static to buy a hit: a dynamic block is always
 *  rendered, at the tail, in its current form.
 *
 *  This module knows nothing about any provider. It reports the prefix
 *  boundary and fingerprints; an adapter decides what, if anything, to do with
 *  them (`RuntimeAdapter.promptCaching`).
 */
import { createHash } from 'node:crypto';
import { cacheRank, type CacheClass, type PromptBlock, type PromptChannel } from './prompt-ir.js';

export interface CacheReceipt {
  /** Fingerprint of STATIC + TASK_STABLE text: identical for every dispatch of
   *  one task on one commit, so siblings and retries share it. */
  stable: string;
  /** As `stable`, plus SESSION_STABLE text: identical across the turns of one
   *  conversation or one handoff. */
  session: string;
  /** Character offset in each channel's rendered text where the dynamic tail
   *  begins. Everything before it is the cacheable prefix. */
  boundary: Record<PromptChannel, number>;
}

/** One rendered block, in layout order: what was actually emitted, after any
 *  demotion, since that is what the cache sees. */
export interface RenderedBlock {
  block: PromptBlock;
  text: string;
}

function fingerprint(rendered: RenderedBlock[], upTo: CacheClass): string {
  const rank = cacheRank(upTo);
  const hash = createHash('sha256');
  for (const { block, text } of rendered) {
    if (cacheRank(block.cacheClass) > rank) continue;
    // Length-prefixed, so ("ab","c") and ("a","bc") do not collide.
    hash.update(`${block.channel}:${block.cacheClass}:${text.length}:${text}\u0000`);
  }
  return hash.digest('hex').slice(0, 16);
}

export function cacheReceipt(
  rendered: RenderedBlock[],
  separator: string,
  channelText: Record<PromptChannel, string>,
): CacheReceipt {
  const boundary: Record<PromptChannel, number> = { system: 0, user: 0 };
  for (const channel of ['system', 'user'] as const) {
    const inChannel = rendered.filter((r) => r.block.channel === channel);
    const firstDynamic = inChannel.findIndex((r) => r.block.cacheClass === 'DYNAMIC');
    if (firstDynamic === -1) {
      boundary[channel] = channelText[channel].length;
      continue;
    }
    // The prefix is every block before the first dynamic one, plus the
    // separator that joins it to the tail.
    const prefix = inChannel.slice(0, firstDynamic).map((r) => r.text).join(separator);
    boundary[channel] = firstDynamic === 0 ? 0 : prefix.length + separator.length;
  }
  return {
    stable: fingerprint(rendered, 'TASK_STABLE'),
    session: fingerprint(rendered, 'SESSION_STABLE'),
    boundary,
  };
}
