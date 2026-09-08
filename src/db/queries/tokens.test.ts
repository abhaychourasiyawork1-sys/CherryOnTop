import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { recordDispatchUsage, tokensByRole } from './tokens.js';

const DB = './test-tokens.db';
afterEach(() => { for (const s of ['', '-journal', '-wal', '-shm']) if (existsSync(DB + s)) unlinkSync(DB + s); });

const usage = (input: number, output: number) => ({
  inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 1,
});

describe('tokensByRole', () => {
  it('aggregates dispatch_usage rows by role and model', () => {
    const db = createDb(DB);
    const t = '2026-09-08T00:00:00.000Z';
    recordDispatchUsage(db, { nodeId: 'a', role: 'plan', model: 'haiku', usage: usage(100, 20), costUsd: 0.001, createdAt: t });
    recordDispatchUsage(db, { nodeId: 'a', role: 'plan', model: 'haiku', usage: usage(50, 10), costUsd: 0.0005, createdAt: t });
    recordDispatchUsage(db, { nodeId: 'a', role: 'execute', model: null, usage: usage(9000, 800), costUsd: 0.09, createdAt: t });

    const { rows } = tokensByRole(db);
    const plan = rows.find((r) => r.role === 'plan')!;
    expect(plan.dispatches).toBe(2);
    expect(plan.inputTokens).toBe(150);
    expect(plan.model).toBe('haiku');
    const exec = rows.find((r) => r.role === 'execute')!;
    expect(exec.model).toBe('(default)');
    expect(exec.inputTokens).toBe(9000);
  });

  it('counts plan-cache hit rows', () => {
    const db = createDb(DB);
    // a plan-cache-hit is recorded as a dispatch_usage row with role 'plan:cache-hit'
    recordDispatchUsage(db, { nodeId: 'a', role: 'plan:cache-hit', model: null, usage: usage(0, 0), costUsd: 0, createdAt: 'x' });
    expect(tokensByRole(db).planCacheHits).toBe(1);
  });
});
