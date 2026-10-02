/** The H2.6 experiment ledger (bench/governor/h26/DESIGN.md §4, §9).
 *
 *  One SQLite file shared by every run of an experiment, separate from each
 *  run's own database: assignments, their uniqueness, the masked count C_mask
 *  reads and the integrity stops are properties of the *experiment*, and a
 *  per-run database could only ever see one task of it. Each record is
 *  inserted once, in one transaction; triggers refuse UPDATE and DELETE.
 *  Nothing in the runtime reads this file except the assignment path. */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface LedgerRow {
  experimentId: string;
  phase: string;
  rootTaskId: string;
  boundaryKey: string;
  z: 'masked' | 'available';
  /** The complete record, canonical JSON. */
  record: string;
  recordSha256: string;
  createdAt: string;
}

export type InsertOutcome =
  | { kind: 'inserted' }
  | { kind: 'conflict'; existing: LedgerRow }
  | { kind: 'failed'; error: string };

export interface Ledger {
  insert(row: LedgerRow): InsertOutcome;
  get(experimentId: string, phase: string, rootTaskId: string): LedgerRow | null;
  countMasked(experimentId: string, phase: string): number;
  /** An assignment-integrity stop recorded for this experiment, if any. */
  stopped(experimentId: string): string | null;
  stop(experimentId: string, reason: string, detail: string, at: string): void;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS assignments (
  experiment_id TEXT NOT NULL, phase TEXT NOT NULL, root_task_id TEXT NOT NULL,
  boundary_key TEXT NOT NULL, z TEXT NOT NULL, record TEXT NOT NULL,
  record_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (experiment_id, phase, root_task_id)
);
CREATE TABLE IF NOT EXISTS stops (
  experiment_id TEXT NOT NULL, reason TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS assignments_no_update BEFORE UPDATE ON assignments BEGIN SELECT RAISE(ABORT, 'ledger is immutable'); END;
CREATE TRIGGER IF NOT EXISTS assignments_no_delete BEFORE DELETE ON assignments BEGIN SELECT RAISE(ABORT, 'ledger is immutable'); END;
CREATE TRIGGER IF NOT EXISTS stops_no_update BEFORE UPDATE ON stops BEGIN SELECT RAISE(ABORT, 'ledger is immutable'); END;
CREATE TRIGGER IF NOT EXISTS stops_no_delete BEFORE DELETE ON stops BEGIN SELECT RAISE(ABORT, 'ledger is immutable'); END;
`;

const fromRow = (r: Record<string, string>): LedgerRow => ({
  experimentId: r.experiment_id, phase: r.phase, rootTaskId: r.root_task_id, boundaryKey: r.boundary_key,
  z: r.z as LedgerRow['z'], record: r.record, recordSha256: r.record_sha256, createdAt: r.created_at,
});

export function openLedger(path: string): Ledger {
  const Database = require('better-sqlite3');
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  // Several runs write concurrently; a writer waits rather than failing.
  db.pragma('busy_timeout = 15000');
  db.exec(SCHEMA);
  const get = db.prepare('SELECT * FROM assignments WHERE experiment_id = ? AND phase = ? AND root_task_id = ?');
  const insert = db.prepare('INSERT INTO assignments VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  return {
    insert(row) {
      try {
        db.transaction(() => insert.run(row.experimentId, row.phase, row.rootTaskId, row.boundaryKey, row.z, row.record, row.recordSha256, row.createdAt))();
        return { kind: 'inserted' };
      } catch (err) {
        const existing = get.get(row.experimentId, row.phase, row.rootTaskId);
        if (existing) return { kind: 'conflict', existing: fromRow(existing) };
        return { kind: 'failed', error: String((err as Error)?.message ?? err) };
      }
    },
    get(experimentId, phase, rootTaskId) {
      const r = get.get(experimentId, phase, rootTaskId);
      return r ? fromRow(r) : null;
    },
    countMasked(experimentId, phase) {
      return (db.prepare("SELECT count(*) AS n FROM assignments WHERE experiment_id = ? AND phase = ? AND z = 'masked'").get(experimentId, phase) as { n: number }).n;
    },
    stopped(experimentId) {
      const r = db.prepare('SELECT reason FROM stops WHERE experiment_id = ? ORDER BY rowid LIMIT 1').get(experimentId) as { reason: string } | undefined;
      return r?.reason ?? null;
    },
    stop(experimentId, reason, detail, at) {
      db.prepare('INSERT INTO stops VALUES (?, ?, ?, ?)').run(experimentId, reason, detail, at);
    },
    close() { db.close(); },
  };
}
