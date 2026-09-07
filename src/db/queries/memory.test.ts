import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { recordRunOutcome, getRuntimeStats, listMemory, type RunOutcome } from './memory.js';

const TEST_DB = './test-memory.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const OUTCOME: RunOutcome = {
  runtime: 'claude-code', succeeded: true, costUsd: 1, latencyMs: 1000,
  complexity: 'medium', delegated: false,
};

function record(db: ReturnType<typeof createDb>, id: string, outcome: Partial<RunOutcome>) {
  recordRunOutcome(db, { id, nodeId: `n-${id}`, outcome: { ...OUTCOME, ...outcome }, createdAt: 't0' });
}

describe('organizational memory', () => {
  it('aggregates observed runs into per-runtime performance', () => {
    const db = createDb(TEST_DB);
    record(db, '1', { costUsd: 2, latencyMs: 1000 });
    record(db, '2', { costUsd: 1, latencyMs: 3000, succeeded: false });
    record(db, '3', { runtime: 'codex', costUsd: 0.5, latencyMs: 500 });

    const stats = getRuntimeStats(db);
    const claude = stats.find((s) => s.runtime === 'claude-code')!;
    expect(claude.runs).toBe(2);
    expect(claude.successRate).toBe(0.5);
    expect(claude.avgCostUsd).toBeCloseTo(1.5, 5);
    expect(claude.avgLatencyMs).toBeCloseTo(2000, 5);
    // Most-observed runtime first — the one the org actually knows about.
    expect(stats[0].runtime).toBe('claude-code');
  });

  it('reports nothing for a runtime that has never run, rather than a baseline', () => {
    const db = createDb(TEST_DB);
    record(db, '1', {});
    expect(getRuntimeStats(db).map((s) => s.runtime)).toEqual(['claude-code']);
  });

  it('starts empty', () => {
    expect(getRuntimeStats(createDb(TEST_DB))).toEqual([]);
  });

  it('keeps each run as its own inspectable observation', () => {
    const db = createDb(TEST_DB);
    record(db, '1', {});
    record(db, '2', { runtime: 'codex' });
    expect(listMemory(db, 'run_outcome')).toHaveLength(2);
    expect(listMemory(db, 'lesson')).toEqual([]);
  });
});
