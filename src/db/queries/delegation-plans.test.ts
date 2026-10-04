import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { saveDelegationPlan, loadDelegationPlan } from './delegation-plans.js';

const TEST_DB = './test-delegation-plans.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const plan = {
  subgoals: ['research', 'build'], after: [[], [0]],
  definitionOfDone: [['notes written'], []], acceptanceChecks: [['file:notes.md'], ['npm test']],
};

describe('delegation plans', () => {
  it('keeps the plan a parent delegated under, including what had not been assigned yet', () => {
    const db = createDb(TEST_DB);
    saveDelegationPlan(db, 'p', plan, 't1');
    expect(loadDelegationPlan(db, 'p')).toEqual(plan);
  });

  it('reads the latest, and only this parent\'s', () => {
    const db = createDb(TEST_DB);
    saveDelegationPlan(db, 'p', { ...plan, subgoals: ['old', 'older'] }, 't1');
    saveDelegationPlan(db, 'p', plan, 't2');
    saveDelegationPlan(db, 'other', { ...plan, subgoals: ['x', 'y'] }, 't3');
    expect(loadDelegationPlan(db, 'p')?.subgoals).toEqual(['research', 'build']);
  });

  it('is undefined when there is none, and for a plan that cannot be trusted', () => {
    const db = createDb(TEST_DB);
    expect(loadDelegationPlan(db, 'p')).toBeUndefined();
    saveDelegationPlan(db, 'p', { subgoals: [] } as never, 't1');
    expect(loadDelegationPlan(db, 'p')).toBeUndefined();
  });

  it('repairs a row that predates contracts or has the wrong shape rather than failing', () => {
    const db = createDb(TEST_DB);
    saveDelegationPlan(db, 'p', { subgoals: ['a', 'b'], after: [[], [7, 0, 'x']] } as never, 't1');
    expect(loadDelegationPlan(db, 'p')).toEqual({
      subgoals: ['a', 'b'], after: [[], [0]], definitionOfDone: [[], []], acceptanceChecks: [[], []],
    });
  });
});
