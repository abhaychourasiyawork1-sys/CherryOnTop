import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { memory } from '../schema.js';
import { subtreeNodeIds } from './nodes.js';
import type { DispatchUsage } from '../../execution/tokens.js';

const KIND = 'dispatch_usage';

export function recordDispatchUsage(
  db: Db,
  r: { nodeId: string; role: string; model: string | null; usage: DispatchUsage; costUsd: number; createdAt: string },
): void {
  db.insert(memory).values({
    id: randomUUID(),
    kind: KIND,
    key: r.role,
    value: { role: r.role, model: r.model, usage: r.usage, costUsd: r.costUsd },
    confidence: null,
    nodeId: r.nodeId,
    createdAt: r.createdAt,
  }).run();
}

export interface RoleTokenRow {
  role: string;
  model: string;
  dispatches: number;
  /** Turns inside the dispatches, summed. The one term whose growth is
   *  superlinear in cost — the conversation prefix is re-read on every turn —
   *  so a comparison that reports tokens but not turns cannot explain itself. */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

interface StoredValue { role: string; model: string | null; usage: DispatchUsage; costUsd: number }

/** A dispatch that did not happen is not a dispatch with zero tokens: averaged
 *  into the per-role rows it would drag every figure towards nothing and hide
 *  the saving it represents. Counted separately, by role. */
const CACHE_HIT_ROLES: Record<string, 'planCacheHits' | 'resultCacheHits'> = {
  'plan:cache-hit': 'planCacheHits',
  'execute:cache-hit': 'resultCacheHits',
};

/** Turns this node has already spent, across every dispatch recorded for it.
 *
 *  Scoped to the node itself rather than its subtree, deliberately: it feeds the
 *  guard that decides whether to open *this* node's next sandbox, and a parent
 *  must not be stopped by turns its children spent under their own budgets. */
export function turnsForNode(db: Db, nodeId: string): number {
  return db.select().from(memory).where(eq(memory.kind, KIND)).all()
    .filter((row) => row.nodeId === nodeId)
    .reduce((sum, row) => sum + ((row.value as StoredValue).usage?.numTurns ?? 0), 0);
}

export function tokensByRole(db: Db, caseId?: string): { rows: RoleTokenRow[]; planCacheHits: number; resultCacheHits: number } {
  const all = db.select().from(memory).where(eq(memory.kind, KIND)).all();
  const scope = caseId ? new Set(subtreeNodeIds(db, caseId)) : null;
  const rows = all.filter((row) => !scope || (row.nodeId && scope.has(row.nodeId)));

  const hits = { planCacheHits: 0, resultCacheHits: 0 };
  const acc = new Map<string, RoleTokenRow>();
  for (const row of rows) {
    const v = row.value as StoredValue;
    const hit = CACHE_HIT_ROLES[v.role];
    if (hit) { hits[hit]++; continue; }
    const model = v.model ?? '(default)';
    const bucket = `${v.role}\0${model}`;
    const cur = acc.get(bucket) ?? { role: v.role, model, dispatches: 0, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
    cur.dispatches += 1;
    cur.turns += v.usage?.numTurns ?? 0;
    cur.inputTokens += v.usage?.inputTokens ?? 0;
    cur.outputTokens += v.usage?.outputTokens ?? 0;
    cur.cacheReadTokens += v.usage?.cacheReadTokens ?? 0;
    cur.costUsd += v.costUsd ?? 0;
    acc.set(bucket, cur);
  }
  return {
    rows: [...acc.values()].sort((a, b) => b.inputTokens - a.inputTokens),
    ...hits,
  };
}
