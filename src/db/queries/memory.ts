import { and, eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { memory } from '../schema.js';

export interface RunOutcome {
  /** The adapter that ran it — the key these rows are aggregated by. */
  runtime: string;
  succeeded: boolean;
  costUsd: number;
  latencyMs: number;
  complexity: 'low' | 'medium' | 'high';
  delegated: boolean;
}

export interface RuntimeStat {
  runtime: string;
  runs: number;
  successRate: number;
  avgCostUsd: number;
  avgLatencyMs: number;
}

export interface MemoryRow {
  id: string;
  kind: string;
  key: string;
  value: unknown;
  confidence: number | null;
  nodeId: string | null;
  createdAt: string;
}

export function recordRunOutcome(
  db: Db,
  record: { id: string; nodeId: string; outcome: RunOutcome; createdAt: string },
): void {
  db.insert(memory).values({
    id: record.id,
    kind: 'run_outcome',
    key: record.outcome.runtime,
    value: record.outcome,
    // A single run is one observation, not a validated lesson. Confidence rises
    // only through aggregation — getRuntimeStats is what turns these into one.
    confidence: null,
    nodeId: record.nodeId,
    createdAt: record.createdAt,
  }).run();
}

/** What the organization has learned about each runtime from its own history.
 *  Nothing is inferred that was not observed: a runtime with no runs simply does
 *  not appear, rather than appearing with a made-up baseline. */
export function getRuntimeStats(db: Db): RuntimeStat[] {
  const rows = db.select().from(memory).where(eq(memory.kind, 'run_outcome')).all();
  const byRuntime = new Map<string, RunOutcome[]>();
  for (const row of rows) {
    const outcome = row.value as RunOutcome;
    byRuntime.set(row.key, [...(byRuntime.get(row.key) ?? []), outcome]);
  }
  return [...byRuntime.entries()]
    .map(([runtime, outcomes]) => ({
      runtime,
      runs: outcomes.length,
      successRate: outcomes.filter((o) => o.succeeded).length / outcomes.length,
      avgCostUsd: mean(outcomes.map((o) => o.costUsd)),
      avgLatencyMs: mean(outcomes.map((o) => o.latencyMs)),
    }))
    .sort((a, b) => b.runs - a.runs);
}

/** Excludes one observation from everything the organization believes.
 *
 *  Implemented by moving the row to a different `kind` rather than adding a
 *  flag: getRuntimeStats already selects on kind, so the row stops counting
 *  without a second condition anywhere, and it stays on disk so the veto is
 *  reversible and visible rather than a deletion. */
export const VETOED_KIND = 'run_outcome_vetoed';

export function setOutcomeVetoed(db: Db, id: string, vetoed: boolean): void {
  db.update(memory)
    .set({ kind: vetoed ? VETOED_KIND : 'run_outcome' })
    .where(eq(memory.id, id))
    .run();
}

export function listMemory(db: Db, kind?: string): MemoryRow[] {
  const query = db.select().from(memory);
  const rows = kind ? query.where(eq(memory.kind, kind)).all() : query.all();
  return rows as MemoryRow[];
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Verified strategy outcomes, keyed at every level they are evidence for.
 *
 *  Stored in the existing `memory` table rather than a second one: the JSON
 *  value already carries whatever shape a row needs, and a separate strategy
 *  store would be a second memory nobody keeps in sync with the first. One row
 *  per (run, level), so a query for "what does this task class say" is a
 *  `kind`+`key` lookup rather than a scan that re-derives the keys.
 *
 *  Only *validated* outcomes get here. A run whose validation failed is
 *  evidence about the run, not about the strategy. */
export const STRATEGY_OUTCOME_KIND = 'strategy_outcome';

/** One key's worth of a run. `key` is `<level>:<value>` so the level is part of
 *  the index rather than something the reader has to filter on. */
export function recordStrategyOutcome(
  db: Db,
  record: { id: string; nodeId: string; createdAt: string; observation: StoredStrategyOutcome },
): void {
  for (const [index, key] of record.observation.task.entries()) {
    db.insert(memory).values({
      id: `${record.id}:${index}`,
      kind: STRATEGY_OUTCOME_KIND,
      key: `${key.level}:${key.value}`,
      value: record.observation,
      // One run is one observation, never a validated lesson. Confidence comes
      // from aggregation — `learning/hierarchical.ts` is what turns these into
      // one, and it shrinks sparse evidence rather than trusting it.
      confidence: null,
      nodeId: record.nodeId,
      createdAt: record.createdAt,
    }).run();
  }
}

/** The shape stored in the row. Structural rather than imported so the query
 *  layer does not depend on the learning layer — the dependency runs the other
 *  way, and inverting it would make storage a consumer of weighting rules. */
export interface StoredStrategyOutcome {
  strategy: string;
  task: Array<{ level: string; value: string }>;
  success: boolean;
  qualityDelta: number;
  costUsd: number;
  latencyMs: number;
  recoveryCount: number;
  validationLevel: string;
  validity: string;
  policyVersion?: unknown;
}

/** Every stored observation for one level and value. Empty when there is no
 *  history, which is the deterministic fallback: a caller with no evidence
 *  keeps its existing behaviour rather than inventing a baseline. */
export function getStrategyOutcomes(db: Db, level: string, value: string): StoredStrategyOutcome[] {
  try {
    return db.select().from(memory)
      .where(and(eq(memory.kind, STRATEGY_OUTCOME_KIND), eq(memory.key, `${level}:${value}`)))
      .all()
      .map((row) => row.value as StoredStrategyOutcome)
      .filter((value): value is StoredStrategyOutcome => typeof value?.strategy === 'string');
  } catch (err) {
    console.error(`Failed to read strategy outcomes for ${level}:${value}:`, err);
    return [];
  }
}
