import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../db/client.js';
import {
  scoreUtility, recordContextUtility, contextUtilityByTaskClass, promotionHints, MIN_OBSERVATIONS,
} from './context-utility.js';

const TEST_DB = './test-context-utility.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

describe('scoring a projection against what the run actually read', () => {
  it('names what the run had to go and find, which is the expensive failure', () => {
    // Selection dropping something the run then needed is the one observable
    // signal that a projection was wrong.
    const scores = scoreUtility({
      selected: ['a.ts', 'b.ts'], excluded: ['c.ts'], read: ['a.ts', 'c.ts'],
    });
    expect(scores.missed).toEqual(['c.ts']);
    expect(scores.recall).toBe(0.5);
  });

  it('names what was paid for and never opened, which is only waste', () => {
    const scores = scoreUtility({ selected: ['a.ts', 'b.ts'], excluded: [], read: ['a.ts'] });
    expect(scores.unused).toEqual(['b.ts']);
    expect(scores.precision).toBe(0.5);
  });

  it('treats an empty selection as neither precise nor imprecise', () => {
    // One is the honest answer to a question nobody asked.
    expect(scoreUtility({ selected: [], excluded: [], read: [] })).toMatchObject({ precision: 1, recall: 1 });
  });

  it('is perfect when selection predicted exactly what was needed', () => {
    const scores = scoreUtility({ selected: ['a.ts'], excluded: ['z.ts'], read: ['a.ts'] });
    expect(scores).toMatchObject({ precision: 1, recall: 1, missed: [], unused: [] });
  });
});

describe('aggregating by task class', () => {
  const observe = (db: ReturnType<typeof createDb>, over: Partial<Parameters<typeof recordContextUtility>[1]> = {}) =>
    recordContextUtility(db, {
      taskClass: 'investigation', nodeId: 'n1',
      selected: ['a.ts'], excluded: ['config.ts'], read: ['a.ts', 'config.ts'],
      outcome: 'success', tokensSelected: 400, tokensAvoided: 0, executionAvoided: false,
      ...over,
    });

  it('summarizes precision, recall and success per class', () => {
    const db = createDb(TEST_DB);
    observe(db);
    observe(db, { outcome: 'failure' });
    observe(db, { taskClass: 'implementation' });

    const stats = contextUtilityByTaskClass(db);
    expect(stats.map((s) => s.taskClass)).toEqual(['implementation', 'investigation']);
    const investigation = stats.find((s) => s.taskClass === 'investigation')!;
    expect(investigation.observations).toBe(2);
    expect(investigation.successRate).toBe(0.5);
    expect(investigation.meanRecall).toBeCloseTo(0.5);
  });

  it('ranks what a class of task keeps having to go and find', () => {
    const db = createDb(TEST_DB);
    observe(db);
    observe(db);
    observe(db, { read: ['a.ts', 'other.ts'], excluded: ['other.ts'] });

    const missed = contextUtilityByTaskClass(db)[0].frequentlyMissed;
    expect(missed[0]).toEqual({ path: 'config.ts', count: 2 });
  });

  it('skips malformed rows rather than throwing on them', () => {
    const db = createDb(TEST_DB);
    observe(db);
    expect(contextUtilityByTaskClass(db)).toHaveLength(1);
  });
});

describe('promotion hints', () => {
  const observe = (db: ReturnType<typeof createDb>) =>
    recordContextUtility(db, {
      taskClass: 'investigation', nodeId: 'n1',
      selected: ['a.ts'], excluded: ['config.ts'], read: ['a.ts', 'config.ts'],
      outcome: 'success', tokensSelected: 400, tokensAvoided: 0, executionAvoided: false,
    });

  it('says nothing until there is enough history to be evidence', () => {
    // A prior built from a single run is superstition, and the scorer would
    // carry it into every future projection.
    const db = createDb(TEST_DB);
    observe(db);
    expect(promotionHints(db, 'investigation')).toEqual([]);
    expect(MIN_OBSERVATIONS).toBe(3);
  });

  it('promotes what a class keeps needing, once it is a pattern', () => {
    const db = createDb(TEST_DB);
    for (let i = 0; i < MIN_OBSERVATIONS; i++) observe(db);
    expect(promotionHints(db, 'investigation')).toEqual(['config.ts']);
  });

  it('says nothing about a class it has never seen', () => {
    expect(promotionHints(createDb(TEST_DB), 'debugging')).toEqual([]);
  });
});
