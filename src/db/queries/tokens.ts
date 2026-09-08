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
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

interface StoredValue { role: string; model: string | null; usage: DispatchUsage; costUsd: number }

export function tokensByRole(db: Db, caseId?: string): { rows: RoleTokenRow[]; planCacheHits: number } {
  const all = db.select().from(memory).where(eq(memory.kind, KIND)).all();
  const scope = caseId ? new Set(subtreeNodeIds(db, caseId)) : null;
  const rows = all.filter((row) => !scope || (row.nodeId && scope.has(row.nodeId)));

  let planCacheHits = 0;
  const acc = new Map<string, RoleTokenRow>();
  for (const row of rows) {
    const v = row.value as StoredValue;
    if (v.role === 'plan:cache-hit') { planCacheHits++; continue; }
    const model = v.model ?? '(default)';
    const bucket = `${v.role}\0${model}`;
    const cur = acc.get(bucket) ?? { role: v.role, model, dispatches: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
    cur.dispatches += 1;
    cur.inputTokens += v.usage?.inputTokens ?? 0;
    cur.outputTokens += v.usage?.outputTokens ?? 0;
    cur.cacheReadTokens += v.usage?.cacheReadTokens ?? 0;
    cur.costUsd += v.costUsd ?? 0;
    acc.set(bucket, cur);
  }
  return {
    rows: [...acc.values()].sort((a, b) => b.inputTokens - a.inputTokens),
    planCacheHits,
  };
}
