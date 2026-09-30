/** One dispatch's context economics, as a single correlated trace.
 *
 *  `recordUsage` already says what a dispatch cost and `context.receipt` says
 *  what the selector chose. What nothing said was how those relate: which
 *  tokens the prompt was made of, what was bought on top of it, what the
 *  compiler dropped, what the run then spent. This is that join — one record
 *  per phase, all carrying the same `dispatchId`, so a benchmark can answer
 *  "where did this task's context tokens come from and what happened to them"
 *  without re-deriving it from four event types.
 *
 *  Two rules keep it from becoming a second copy of anything:
 *
 *   - **References and counts, never content.** A record carries a token
 *     count, a path or ref, and a short reason. Free-text fields are clipped to
 *     `MAX_FIELD_CHARS`, so a payload cannot ride in as an "explanation"; the
 *     compile receipt is recorded per block by size, not by text.
 *   - **Total.** Recording, flushing and summarising never throw. A run must
 *     never fail because it was being measured (the contract `recordUsage`
 *     already holds).
 */
import type { CacheClass } from '../prompt/prompt-ir.js';
import type { PromptCompileReceipt } from '../prompt/prompt-compiler.js';

export const LEDGER_EVENT = 'context.ledger';

/** Enough for a path, a ref or a one-line reason; not enough to carry content. */
export const MAX_FIELD_CHARS = 200;

export type ContextPhase =
  | 'select'       // the selector chose a projection
  | 'materialize'  // a representation of one artifact was bought
  | 'compile'      // the prompt compiler produced the final argv
  | 'model'        // the runtime spent tokens against it
  | 'visible'      // how much context the model could see on its busiest turn
  | 'retain'       // a result was classified for retention
  | 'prune'        // model-visible content was replaced by a reference
  | 'compact'      // model-visible history was summarised
  | 'reuse'        // an earlier result or working-set ref stood in for work
  | 'validate';    // the outcome was checked

export interface ContextLedgerRecord {
  taskId: string;
  nodeId: string;
  /** The logical dispatch: one prompt, however many attempts ran it. */
  dispatchId: string;
  phase: ContextPhase;
  tokens?: number;
  sourceRef?: string;
  /** For `materialize`: `full`, `symbol`, `range`… — what level was bought. */
  representation?: string;
  cacheClass?: CacheClass;
  retentionClass?: string;
  /** For `compile`: the prompt block family (`goal`, `repo-context`…). */
  kind?: string;
  /** For `compile`: the stable-prefix fingerprint. */
  fingerprint?: string;
  reason?: string;
  createdAt: string;
}

type Fields = Partial<Omit<ContextLedgerRecord, 'taskId' | 'nodeId' | 'dispatchId' | 'phase' | 'createdAt'>>;

const clip = (text: string | undefined): string | undefined =>
  text === undefined ? undefined : text.length <= MAX_FIELD_CHARS ? text : text.slice(0, MAX_FIELD_CHARS);

export interface DispatchLedger {
  record(phase: ContextPhase, fields?: Fields): void;
  /** Records a compiled prompt: one row per rendered block, one per dropped
   *  block, and one summary row carrying the stable-prefix fingerprint. */
  recordCompile(receipt: PromptCompileReceipt): void;
  records(): ContextLedgerRecord[];
  /** Emits the trace as one event. At most once; a second call is a no-op. */
  flush(sink: (type: string, payload: { dispatchId: string; records: ContextLedgerRecord[] }) => void): void;
}

export function createDispatchLedger(
  ids: { taskId: string; nodeId: string; dispatchId: string },
  now: () => string = () => new Date().toISOString(),
): DispatchLedger {
  const rows: ContextLedgerRecord[] = [];
  let flushed = false;

  const record: DispatchLedger['record'] = (phase, fields = {}) => {
    try {
      rows.push({
        ...ids, phase,
        ...(fields.tokens !== undefined ? { tokens: Math.max(0, Math.round(fields.tokens)) } : {}),
        ...(fields.sourceRef !== undefined ? { sourceRef: clip(fields.sourceRef) } : {}),
        ...(fields.representation !== undefined ? { representation: clip(fields.representation) } : {}),
        ...(fields.cacheClass !== undefined ? { cacheClass: fields.cacheClass } : {}),
        ...(fields.retentionClass !== undefined ? { retentionClass: clip(fields.retentionClass) } : {}),
        ...(fields.kind !== undefined ? { kind: clip(fields.kind) } : {}),
        ...(fields.fingerprint !== undefined ? { fingerprint: clip(fields.fingerprint) } : {}),
        ...(fields.reason !== undefined ? { reason: clip(fields.reason) } : {}),
        createdAt: now(),
      });
    } catch {
      // Measuring must not cost the run.
    }
  };

  return {
    record,
    recordCompile(receipt) {
      for (const block of receipt.blocks) {
        record('compile', {
          kind: block.kind, tokens: block.tokens, cacheClass: block.cacheClass,
          ...(block.sourceRef ? { sourceRef: block.sourceRef } : {}),
          reason: block.level === 0 ? 'rendered' : `demoted:${block.level}`,
        });
      }
      for (const id of receipt.dropped) record('compile', { tokens: 0, reason: `dropped:${id}` });
      // No `tokens` here: the rows above already sum to the total, and a second
      // figure would double-count it in every per-phase aggregate.
      record('compile', {
        fingerprint: receipt.cache.stable,
        reason: `${receipt.status} total=${receipt.totalTokens} channels=${receipt.bytes.system}+${receipt.bytes.user}B pressure=${receipt.pressure.state}`,
      });
    },
    records: () => rows.map((r) => ({ ...r })),
    flush(sink) {
      if (flushed || rows.length === 0) return;
      flushed = true;
      try {
        sink(LEDGER_EVENT, { dispatchId: ids.dispatchId, records: rows.map((r) => ({ ...r })) });
      } catch (err) {
        console.error(`Failed to flush the context ledger for ${ids.dispatchId}:`, err);
      }
    },
  };
}

export interface ContextLedgerSummary {
  dispatches: number;
  tokensByPhase: Partial<Record<ContextPhase, number>>;
  acquisitions: { whole: number; targeted: number; targetedRate: number; wholeFileRate: number };
  prunedTokens: number;
  compactedTokens: number;
  /** Prompt tokens by block family, from the compile rows. */
  promptTokensByKind: Record<string, number>;
  droppedBlocks: number;
  demotedBlocks: number;
  /** The largest context any dispatch's model could see on one turn. */
  peakVisibleTokens: number;
  /** How many different stable prefixes the dispatches used. Fewer than
   *  dispatches means siblings and retries are sharing a cacheable prefix. */
  distinctStablePrefixes: number;
}

/** Aggregates records from any number of dispatches. Total. */
export function summarizeContextLedger(records: ContextLedgerRecord[]): ContextLedgerSummary {
  const tokensByPhase: Partial<Record<ContextPhase, number>> = {};
  const promptTokensByKind: Record<string, number> = {};
  const dispatches = new Set<string>();
  const prefixes = new Set<string>();
  let whole = 0;
  let targeted = 0;
  let dropped = 0;
  let demoted = 0;
  let peakVisible = 0;

  for (const r of records) {
    dispatches.add(r.dispatchId);
    if (r.tokens !== undefined) tokensByPhase[r.phase] = (tokensByPhase[r.phase] ?? 0) + r.tokens;
    if (r.phase === 'visible' && r.tokens !== undefined) peakVisible = Math.max(peakVisible, r.tokens);
    if (r.phase === 'materialize') {
      if (r.representation === 'full') whole++;
      else targeted++;
    }
    if (r.phase === 'compile') {
      if (r.kind && r.tokens !== undefined) promptTokensByKind[r.kind] = (promptTokensByKind[r.kind] ?? 0) + r.tokens;
      if (r.reason?.startsWith('dropped:')) dropped++;
      if (r.reason?.startsWith('demoted:')) demoted++;
      if (r.fingerprint) prefixes.add(r.fingerprint);
    }
  }

  const acquired = whole + targeted;
  return {
    dispatches: dispatches.size,
    tokensByPhase,
    acquisitions: {
      whole, targeted,
      targetedRate: acquired === 0 ? 0 : targeted / acquired,
      wholeFileRate: acquired === 0 ? 0 : whole / acquired,
    },
    prunedTokens: tokensByPhase.prune ?? 0,
    peakVisibleTokens: peakVisible,
    compactedTokens: tokensByPhase.compact ?? 0,
    promptTokensByKind,
    droppedBlocks: dropped,
    demotedBlocks: demoted,
    distinctStablePrefixes: prefixes.size,
  };
}
