import { eq } from 'drizzle-orm';
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
