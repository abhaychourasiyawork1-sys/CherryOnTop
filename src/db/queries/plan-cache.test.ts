import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { memory } from '../schema.js';
import { planCacheKey, getCachedPlan, putCachedPlan } from './plan-cache.js';

const DB = './test-plancache.db';
afterEach(() => { for (const s of ['', '-journal', '-wal', '-shm']) if (existsSync(DB + s)) unlinkSync(DB + s); });

describe('plan cache', () => {
  it('planCacheKey is stable and depends on both goal and head', () => {
    expect(planCacheKey('g', 'h')).toBe(planCacheKey('g', 'h'));
    expect(planCacheKey('g', 'h')).not.toBe(planCacheKey('g', 'h2'));
    expect(planCacheKey('g', 'h')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a stored plan within TTL and null past it', () => {
    const db = createDb(DB);
    const key = planCacheKey('goal', 'head1');
    putCachedPlan(db, key, ['sub a', 'sub b'], 'head1', '2026-09-08T00:00:00.000Z');

    const fresh = new Date('2026-09-08T05:00:00.000Z');
    expect(getCachedPlan(db, key, 24, fresh)).toEqual({ subgoals: ['sub a', 'sub b'], after: [], definitionOfDone: [[], []], acceptanceChecks: [[], []] });

    const stale = new Date('2026-09-10T00:00:00.000Z');
    expect(getCachedPlan(db, key, 24, stale)).toBeNull();
  });

  it('ttlHours of 0 always misses', () => {
    const db = createDb(DB);
    const key = planCacheKey('goal', 'head1');
    putCachedPlan(db, key, ['x', 'y'], 'head1', new Date().toISOString());
    expect(getCachedPlan(db, key, 0)).toBeNull();
  });

  it('a corrupt row is treated as a miss, not an error, and a never-stored key is a miss', () => {
    const db = createDb(DB);
    db.insert(memory).values({
      id: 'corrupt-1',
      kind: 'plan',
      key: 'corrupt-key',
      value: { subgoals: 'nope' },
      confidence: null,
      nodeId: null,
      createdAt: new Date().toISOString(),
    }).run();

    expect(getCachedPlan(db, 'corrupt-key', 24)).toBeNull();
    expect(getCachedPlan(db, 'never-stored', 24)).toBeNull();
  });
});

it('round-trips "this goal does not split", which costs a whole sandbox to recompute', () => {
  const db = createDb(DB);
  const key = planCacheKey('fix the typo in README', 'headN');
  putCachedPlan(db, key, [], 'headN', new Date().toISOString());
  // Distinguishable from a miss: null means "never asked", [] means "asked, and
  // the answer was no". Collapsing the two is what made the answer un-cacheable.
  expect(getCachedPlan(db, key, 24)).toEqual({ subgoals: [], after: [], definitionOfDone: [], acceptanceChecks: [] });
  expect(getCachedPlan(db, planCacheKey('something else', 'headN'), 24)).toBeNull();
});

it('carries each piece\'s contract with the plan, and reads a row from before contracts as having none', () => {
  const db = createDb(DB);
  const key = planCacheKey('goal', 'abc');
  putCachedPlan(db, key, ['a', 'b'], 'abc', new Date().toISOString(), [[], [0]], {
    definitionOfDone: [['a done'], []], acceptanceChecks: [['npm test'], []],
  });
  expect(getCachedPlan(db, key, 24)).toEqual({
    subgoals: ['a', 'b'], after: [[], [0]], definitionOfDone: [['a done'], []], acceptanceChecks: [['npm test'], []],
  });
});

it('repairs malformed stored contracts instead of trusting them', () => {
  const db = createDb(DB);
  const key = planCacheKey('goal2', 'abc');
  putCachedPlan(db, key, ['a', 'b'], 'abc', new Date().toISOString(), [], {
    definitionOfDone: [[7, 'ok'] as never, 'not a list' as never], acceptanceChecks: 'nope' as never,
  });
  expect(getCachedPlan(db, key, 24)).toMatchObject({ definitionOfDone: [['ok'], []], acceptanceChecks: [[], []] });
});
