/** Running a candidate policy alongside the real one, and never letting it
 *  touch anything.
 *
 *  A shadow's whole value is that it is inert. The moment a shadow decision can
 *  change what happens — even through a side effect, even by being slow — it
 *  stops being a measurement of the change and becomes part of it.
 *
 *  So the contract here is deliberately narrow: take the decision production
 *  made, take the decision a candidate would have made, write down both and what
 *  actually happened. Nothing returns a decision. There is no way to use this
 *  module to decide anything, which is the point.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { memory } from '../db/schema.js';
import type { DecisionReceipt, DecisionType } from '../decision/types.js';

const KIND = 'shadow_decision';

export interface ShadowCapture {
  nodeId: string;
  /** What the candidate policy is called, so several can run at once. */
  policy: string;
  production: DecisionReceipt;
  shadow: DecisionReceipt;
}

export interface ShadowRecord extends ShadowCapture {
  id: string;
  agreed: boolean;
  /** Shadow minus production. Negative means the shadow would have been
   *  cheaper. Predictions, not outcomes — reconciled by `reconcileShadow`. */
  predictedDelta: { tokens: number; latencyMs: number; costUsd: number };
  createdAt: string;
  /** What the production decision actually cost, once known. */
  actual?: { tokens: number; latencyMs: number; costUsd: number; succeeded: boolean };
}

/** Records what the candidate would have done. Total, and returns the record
 *  rather than anything actionable. */
export function captureShadow(db: Db, capture: ShadowCapture): ShadowRecord {
  const record: ShadowRecord = {
    ...capture,
    id: randomUUID(),
    agreed: capture.production.chosen === capture.shadow.chosen,
    predictedDelta: {
      tokens: capture.shadow.estimate.tokens - capture.production.estimate.tokens,
      latencyMs: capture.shadow.estimate.latencyMs - capture.production.estimate.latencyMs,
      costUsd: capture.shadow.estimate.costUsd - capture.production.estimate.costUsd,
    },
    createdAt: new Date().toISOString(),
  };

  try {
    db.insert(memory).values({
      id: record.id, kind: KIND, key: capture.policy, value: record,
      confidence: null, nodeId: capture.nodeId, createdAt: record.createdAt,
    }).run();
  } catch (err) {
    // A shadow that can fail a run is worse than no shadow.
    console.error(`Failed to capture a shadow decision for node ${capture.nodeId}:`, err);
  }
  return record;
}

/** Attaches what the production decision actually cost, so a prediction can be
 *  checked against an outcome rather than against another prediction. */
export function reconcileShadow(
  db: Db,
  id: string,
  actual: { tokens: number; latencyMs: number; costUsd: number; succeeded: boolean },
): void {
  try {
    const row = db.select().from(memory).where(eq(memory.id, id)).all()[0];
    if (!row) return;
    db.update(memory).set({ value: { ...(row.value as ShadowRecord), actual } }).where(eq(memory.id, id)).run();
  } catch (err) {
    console.error(`Failed to reconcile shadow decision ${id}:`, err);
  }
}

export function listShadowRecords(db: Db, policy?: string): ShadowRecord[] {
  return db.select().from(memory).where(eq(memory.kind, KIND)).all()
    .map((row) => row.value as ShadowRecord)
    .filter((record): record is ShadowRecord =>
      typeof record?.id === 'string' && (policy === undefined || record.policy === policy));
}

export interface ShadowSummary {
  policy: string;
  decisions: number;
  agreementRate: number;
  /** Where they disagreed, counted by what each chose. The useful view: "the
   *  shadow would have reused where production ran a model, 12 times". */
  disagreements: { production: DecisionType; shadow: DecisionType; count: number }[];
  /** Summed predicted delta across disagreements only — agreeing decisions
   *  contribute nothing to a comparison. */
  predictedTokenDelta: number;
  /** How often the production decision succeeded, where that is known. Null
   *  when nothing has been reconciled: a comparison against unreconciled
   *  predictions would be two guesses, not a measurement. */
  productionSuccessRate: number | null;
}

export function summarizeShadow(records: ShadowRecord[], policy: string): ShadowSummary {
  const scoped = records.filter((record) => record.policy === policy);
  const disagreed = scoped.filter((record) => !record.agreed);

  const counts = new Map<string, { production: DecisionType; shadow: DecisionType; count: number }>();
  for (const record of disagreed) {
    const key = `${record.production.chosen}\0${record.shadow.chosen}`;
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { production: record.production.chosen, shadow: record.shadow.chosen, count: 1 });
  }

  const reconciled = scoped.filter((record) => record.actual !== undefined);

  return {
    policy,
    decisions: scoped.length,
    agreementRate: scoped.length === 0 ? 1 : (scoped.length - disagreed.length) / scoped.length,
    disagreements: [...counts.values()].sort((a, b) => b.count - a.count),
    predictedTokenDelta: disagreed.reduce((sum, record) => sum + record.predictedDelta.tokens, 0),
    productionSuccessRate: reconciled.length === 0
      ? null
      : reconciled.filter((record) => record.actual!.succeeded).length / reconciled.length,
  };
}
