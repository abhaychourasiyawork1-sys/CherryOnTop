/** Compiles a `PromptDocument` into the two strings a runtime is handed, under
 *  one budget, or refuses to.
 *
 *  Order of operations — the architecture of the file:
 *
 *    validate → dedupe → lay out → measure → (demote until it fits) → verify → render
 *
 *  Demotion is deterministic and goes in one direction only:
 *
 *   1. optional blocks, lowest priority first; within equal priority the
 *      largest first, so a loss is shared rather than landing on whichever
 *      block happened to come last. Each step is one rung down the block's
 *      `fallbacks`, or its removal when it has none left;
 *   2. required blocks, through their own fallbacks, largest first;
 *   3. otherwise the compile is *refused*. A required block that cannot fit is
 *      never truncated: half a task statement is a different task, and an
 *      agent told half a file believes it has seen all of it.
 *
 *  The verify step is the invariant: whatever `compilePrompt` returns as
 *  content fits both ceilings, measured on the final bytes. There is no path
 *  that logs an overrun and ships it.
 */
import { estimateTokens } from '../context/candidates.js';
import { cacheReceipt, type CacheReceipt, type RenderedBlock } from './cache-layout.js';
import {
  BLOCK_SEPARATOR, assertWellFormed, dedupe, layoutOrder,
  type CacheClass, type PromptBlock, type PromptChannel, type PromptDocument,
} from './prompt-ir.js';
import { effectiveInputTokens, type PromptBudget } from './prompt-budget.js';

export type CompileStatus = 'ok' | 'demoted' | 'refused';

export interface BlockReceipt {
  id: string;
  kind: string;
  channel: PromptChannel;
  cacheClass: CacheClass;
  tokens: number;
  bytes: number;
  /** 0 is the block as supplied; n is the nth fallback. */
  level: number;
  sourceRef?: string;
}

export interface DemotionReceipt { id: string; level: number; fromTokens: number; toTokens: number }

export interface PromptCompileReceipt {
  version: 1;
  status: CompileStatus;
  budget: { effectiveTokens: number; maxBytesPerChannel: number };
  totalTokens: number;
  bytes: Record<PromptChannel, number>;
  blocks: BlockReceipt[];
  dropped: string[];
  demoted: DemotionReceipt[];
  merged: string[];
  reasons: string[];
  cache: CacheReceipt;
}

export interface CompiledPrompt {
  system: string;
  user: string;
  receipt: PromptCompileReceipt;
}

interface Slot { block: PromptBlock; level: number; dropped: boolean; firstTokens: number }

const textOf = (slot: Slot): string =>
  slot.level === 0 ? slot.block.content : (slot.block.fallbacks?.[slot.level - 1] ?? '');

const tokensOf = (slot: Slot): number => estimateTokens(textOf(slot));
const bytesOf = (slot: Slot): number => Buffer.byteLength(textOf(slot), 'utf8');

const hasFallback = (slot: Slot): boolean => slot.level < (slot.block.fallbacks?.length ?? 0);

function channelBytes(slots: Slot[], channel: PromptChannel): number {
  const live = slots.filter((s) => !s.dropped && s.block.channel === channel);
  if (live.length === 0) return 0;
  return live.reduce((sum, s) => sum + bytesOf(s), 0) + BLOCK_SEPARATOR.length * (live.length - 1);
}

function totalTokens(slots: Slot[]): number {
  return slots.filter((s) => !s.dropped).reduce((sum, s) => sum + tokensOf(s), 0);
}

/** Which channels are over their byte ceiling, and whether the token ceiling is
 *  breached. Both are checked on the current rendering, every iteration. */
function violations(slots: Slot[], budget: PromptBudget, tokenCeiling: number) {
  const overBytes = (['system', 'user'] as const).filter((c) => channelBytes(slots, c) > budget.maxBytesPerChannel);
  return { overBytes, overTokens: totalTokens(slots) > tokenCeiling };
}

/** The next slot to shrink and how, or null when nothing is left to give. */
function nextStep(slots: Slot[], over: ReturnType<typeof violations>): Slot | null {
  const relevant = (slot: Slot) =>
    !slot.dropped && (over.overTokens || over.overBytes.includes(slot.block.channel));

  // Rank by how much shrinking is worth *taking*: optional before required,
  // lower priority first, then larger first so equal-priority blocks share the
  // loss, then id so the choice never depends on iteration order.
  const shrinkable = (slot: Slot) => relevant(slot) && (hasFallback(slot) || !slot.block.required);
  const pool = slots.filter(shrinkable);
  if (pool.length === 0) return null;
  return pool.sort((a, b) =>
    Number(a.block.required) - Number(b.block.required)
    || a.block.priority - b.block.priority
    || tokensOf(b) - tokensOf(a)
    || bytesOf(b) - bytesOf(a)
    || (a.block.id < b.block.id ? -1 : 1))[0];
}

export function compilePrompt(document: PromptDocument, budget: PromptBudget): CompiledPrompt {
  assertWellFormed(document);
  const { kept, merged } = dedupe(document.blocks);
  const ordered = layoutOrder(kept.filter((block) => block.content.length > 0));
  const slots: Slot[] = ordered.map((block) => ({ block, level: 0, dropped: false, firstTokens: estimateTokens(block.content) }));

  const tokenCeiling = effectiveInputTokens(budget);
  const dropped: string[] = [];
  const demoted = new Map<string, DemotionReceipt>();
  const reasons: string[] = [];

  for (;;) {
    const over = violations(slots, budget, tokenCeiling);
    if (over.overBytes.length === 0 && !over.overTokens) break;

    const target = nextStep(slots, over);
    if (!target) {
      // Nothing optional remains and no required block can shrink further.
      for (const channel of over.overBytes) {
        const required = slots.filter((s) => !s.dropped && s.block.channel === channel && s.block.required);
        reasons.push(`${channel} channel needs ${channelBytes(slots, channel)} bytes for ${required.map((s) => `"${s.block.id}"`).join(', ') || 'its content'}; the ceiling is ${budget.maxBytesPerChannel}`);
      }
      if (over.overTokens) {
        const required = slots.filter((s) => !s.dropped && s.block.required);
        reasons.push(`required blocks ${required.map((s) => `"${s.block.id}"`).join(', ')} need ~${totalTokens(slots)} tokens; the ceiling is ${tokenCeiling}`);
      }
      return refused(slots, budget, tokenCeiling, dropped, [...demoted.values()], merged, reasons);
    }

    if (hasFallback(target)) {
      target.level += 1;
      demoted.set(target.block.id, { id: target.block.id, level: target.level, fromTokens: target.firstTokens, toTokens: tokensOf(target) });
    } else {
      target.dropped = true;
      dropped.push(target.block.id);
      demoted.delete(target.block.id);
    }
  }

  return finish(slots, budget, tokenCeiling, dropped, [...demoted.values()], merged, reasons);
}

function rendered(slots: Slot[]): RenderedBlock[] {
  return slots.filter((s) => !s.dropped && textOf(s).length > 0).map((s) => ({ block: s.block, text: textOf(s) }));
}

function channelText(blocks: RenderedBlock[]): Record<PromptChannel, string> {
  const join = (channel: PromptChannel) => blocks.filter((r) => r.block.channel === channel).map((r) => r.text).join(BLOCK_SEPARATOR);
  return { system: join('system'), user: join('user') };
}

function receiptOf(
  status: CompileStatus,
  slots: Slot[],
  budget: PromptBudget,
  tokenCeiling: number,
  dropped: string[],
  demoted: DemotionReceipt[],
  merged: string[],
  reasons: string[],
  blocks: RenderedBlock[],
  text: Record<PromptChannel, string>,
): PromptCompileReceipt {
  const live = slots.filter((s) => !s.dropped && textOf(s).length > 0);
  return {
    version: 1,
    status,
    budget: { effectiveTokens: tokenCeiling, maxBytesPerChannel: budget.maxBytesPerChannel },
    totalTokens: live.reduce((sum, s) => sum + tokensOf(s), 0),
    bytes: { system: Buffer.byteLength(text.system, 'utf8'), user: Buffer.byteLength(text.user, 'utf8') },
    blocks: live.map((s) => ({
      id: s.block.id, kind: s.block.kind, channel: s.block.channel, cacheClass: s.block.cacheClass,
      tokens: tokensOf(s), bytes: bytesOf(s), level: s.level,
      ...(s.block.sourceRef ? { sourceRef: s.block.sourceRef } : {}),
    })),
    dropped, demoted, merged, reasons,
    cache: cacheReceipt(blocks, BLOCK_SEPARATOR, text),
  };
}

function finish(
  slots: Slot[], budget: PromptBudget, tokenCeiling: number,
  dropped: string[], demoted: DemotionReceipt[], merged: string[], reasons: string[],
): CompiledPrompt {
  const blocks = rendered(slots);
  const text = channelText(blocks);
  // The invariant, checked on the bytes about to be returned rather than
  // inferred from the loop that produced them.
  const fits = Buffer.byteLength(text.system, 'utf8') <= budget.maxBytesPerChannel
    && Buffer.byteLength(text.user, 'utf8') <= budget.maxBytesPerChannel
    && slots.filter((s) => !s.dropped).reduce((sum, s) => sum + tokensOf(s), 0) <= tokenCeiling;
  if (!fits) return refused(slots, budget, tokenCeiling, dropped, demoted, merged, [...reasons, 'final verification failed']);
  const status: CompileStatus = dropped.length > 0 || demoted.length > 0 ? 'demoted' : 'ok';
  return { system: text.system, user: text.user, receipt: receiptOf(status, slots, budget, tokenCeiling, dropped, demoted, merged, reasons, blocks, text) };
}

function refused(
  slots: Slot[], budget: PromptBudget, tokenCeiling: number,
  dropped: string[], demoted: DemotionReceipt[], merged: string[], reasons: string[],
): CompiledPrompt {
  const empty = { system: '', user: '' };
  // The receipt still explains what was attempted, but the content is empty: a
  // refused compile has nothing that may be sent.
  const receipt = receiptOf('refused', slots, budget, tokenCeiling, dropped, demoted, merged, reasons, [], empty);
  return { ...empty, receipt };
}
