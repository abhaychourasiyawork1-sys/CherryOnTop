import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { insertNode } from './nodes.js';
import { recordDispatchUsage, tokensByRole, tokensForNode, policyVersionsSeen } from './tokens.js';

const DB = './test-tokens.db';
afterEach(() => { for (const s of ['', '-journal', '-wal', '-shm']) if (existsSync(DB + s)) unlinkSync(DB + s); });

const usage = (input: number, output: number) => ({
  inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 1,
});

const CONTRACT = {
  goal: 'test',
  definition_of_done: ['done'],
  authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 0 },
  constraints: [],
};

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
    // Turns, not just dispatches: two 1-turn plans is a different run from one
    // 2-turn plan, and only one of the two numbers says which.
    expect(plan.turns).toBe(2);
    expect(plan.inputTokens).toBe(150);
    expect(plan.model).toBe('haiku');
    const exec = rows.find((r) => r.role === 'execute')!;
    expect(exec.model).toBe('(default)');
    expect(exec.inputTokens).toBe(9000);
  });

  it('scopes to a case (subtree) when caseId is given, excluding rows outside it', () => {
    const db = createDb(DB);
    const t = '2026-09-08T00:00:00.000Z';
    const add = (id: string, parentId: string | null) =>
      insertNode(db, { id, parentId, goal: id, contract: CONTRACT, state: 'CREATED', createdAt: t, updatedAt: t });
    // Two distinct subtrees: caseA (root 'a' + child 'a1'), caseB (root 'b').
    add('a', null);
    add('a1', 'a');
    add('b', null);

    recordDispatchUsage(db, { nodeId: 'a', role: 'plan', model: 'haiku', usage: usage(100, 10), costUsd: 0.001, createdAt: t });
    recordDispatchUsage(db, { nodeId: 'a1', role: 'execute', model: 'haiku', usage: usage(200, 20), costUsd: 0.002, createdAt: t });
    recordDispatchUsage(db, { nodeId: 'b', role: 'plan', model: 'haiku', usage: usage(9999, 999), costUsd: 9, createdAt: t });

    const { rows } = tokensByRole(db, 'a');
    // In scope: both rows under the 'a' subtree, combined into the 'plan' and 'execute' buckets.
    const plan = rows.find((r) => r.role === 'plan')!;
    expect(plan.inputTokens).toBe(100);
    const exec = rows.find((r) => r.role === 'execute')!;
    expect(exec.inputTokens).toBe(200);
    // Out of scope: caseB's huge numbers must not leak in — this is what would
    // catch an inverted predicate or a swapped subtreeNodeIds argument order.
    expect(plan.inputTokens).not.toBe(9999 + 100);
    expect(rows.reduce((sum, r) => sum + r.dispatches, 0)).toBe(2);
  });

  it('counts plan-cache hit rows', () => {
    const db = createDb(DB);
    // a plan-cache-hit is recorded as a dispatch_usage row with role 'plan:cache-hit'
    recordDispatchUsage(db, { nodeId: 'a', role: 'plan:cache-hit', model: null, usage: usage(0, 0), costUsd: 0, createdAt: 'x' });
    expect(tokensByRole(db).planCacheHits).toBe(1);
  });
});

describe('policyVersionsSeen', () => {
  it('keeps two policy generations distinguishable rather than averaging them', () => {
    const db = createDb(DB);
    const t = '2026-09-13T00:00:00.000Z';
    recordDispatchUsage(db, {
      nodeId: 'a', role: 'execute', model: null, usage: usage(10, 1), costUsd: 0.1, createdAt: t,
      policy: { context: 'lexical', execution: 'exec-1' },
    });
    recordDispatchUsage(db, {
      nodeId: 'a', role: 'execute', model: null, usage: usage(10, 1), costUsd: 0.1, createdAt: t,
      policy: { context: 'ctx-1', execution: 'exec-1' },
    });

    expect(policyVersionsSeen(db)).toEqual(['ctx-1/exec-1', 'lexical/exec-1']);
  });

  it('says nothing at all about rows recorded before versions existed', () => {
    const db = createDb(DB);
    recordDispatchUsage(db, {
      nodeId: 'a', role: 'execute', model: null, usage: usage(10, 1), costUsd: 0.1,
      createdAt: '2026-09-13T00:00:00.000Z',
    });
    expect(policyVersionsSeen(db)).toEqual([]);
  });
});

describe('tokensForNode', () => {
  const t = '2026-09-08T00:00:00.000Z';

  it('sums input and output across a node’s dispatches', () => {
    const db = createDb(DB);
    recordDispatchUsage(db, {
      nodeId: 'n1', role: 'execute', model: null, createdAt: t, costUsd: 0,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheCreationTokens: 0, numTurns: 3 },
    });
    recordDispatchUsage(db, { nodeId: 'n1', role: 'plan', model: null, usage: usage(50, 5), costUsd: 0, createdAt: t });
    // Cache reads are a slice of input; counting them would bill the same
    // tokens twice.
    expect(tokensForNode(db, 'n1')).toBe(175);
  });

  it('counts nothing for another node', () => {
    const db = createDb(DB);
    recordDispatchUsage(db, { nodeId: 'n1', role: 'execute', model: null, usage: usage(100, 20), costUsd: 0, createdAt: t });
    expect(tokensForNode(db, 'n2')).toBe(0);
  });
});
