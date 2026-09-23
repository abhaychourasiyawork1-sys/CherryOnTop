import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../db/client.js';
import {
  promoteLesson, effectiveLessonWeight, calibrationFor, triggerSimilarity,
  observe, activate, listLessons, isLearnable, SUPPORT_TO_SHADOW,
  type Lesson,
} from './lessons.js';

const TEST_DB = './test-lessons.db';

afterEach(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const claim = {
  scope: 'task_class' as const,
  trigger: { taskClass: 'debugging' },
  recommendation: { field: 'contextBudget', multiplier: 0.8 },
};

describe('the lesson lifecycle', () => {
  it('does not treat one observation as an active lesson', () => {
    const lesson = promoteLesson({ ...claim, supportCount: 1, contradictCount: 0, observedEffect: -0.2 });
    expect(lesson.status).toBe('CANDIDATE');
  });

  it('will not activate on support alone, however much of it there is', () => {
    const lesson = promoteLesson({ ...claim, supportCount: 200, contradictCount: 0, observedEffect: -0.2 });
    // Two hundred production runs still only reach shadow. Activation needs
    // evidence a run cannot produce about itself.
    expect(lesson.status).toBe('SHADOW');
  });

  it('activates only with explicit validation', () => {
    const lesson = promoteLesson({ ...claim, supportCount: 20, contradictCount: 0, observedEffect: -0.2, validated: true });
    expect(lesson.status).toBe('ACTIVE');
  });

  it('retires a claim that is contradicted too often to be one claim', () => {
    const lesson = promoteLesson({ ...claim, supportCount: 6, contradictCount: 4, observedEffect: 0 });
    expect(lesson.status).toBe('RETIRED');
    expect(lesson.retiredReason).toContain('contradicted');
  });

  it('refuses a recommendation about a field that is a constraint', () => {
    for (const field of ['authority.budget_usd', 'sandbox.isolation', 'dod', 'spendCapUsd', 'allowedTools']) {
      expect(isLearnable(field)).toBe(false);
      const lesson = promoteLesson({
        ...claim, recommendation: { field, multiplier: 2 },
        supportCount: 50, contradictCount: 0, observedEffect: -1, validated: true,
      });
      expect(lesson.status).toBe('RETIRED');
    }
  });
});

describe('effectiveLessonWeight', () => {
  it('reduces the weight of old evidence', () => {
    expect(effectiveLessonWeight({ supportCount: 20, contradictCount: 2, ageDays: 365, similarity: 1 }))
      .toBeLessThan(effectiveLessonWeight({ supportCount: 20, contradictCount: 2, ageDays: 7, similarity: 1 }));
  });

  it('is zero with no evidence at all', () => {
    expect(effectiveLessonWeight({ supportCount: 0, contradictCount: 0, ageDays: 0, similarity: 1 })).toBe(0);
  });

  it('collapses on a context mismatch however large the sample', () => {
    expect(effectiveLessonWeight({ supportCount: 500, contradictCount: 0, ageDays: 0, similarity: 0 })).toBe(0);
  });
});

describe('calibrationFor', () => {
  const active = (over: Partial<Lesson> = {}): Lesson => promoteLesson({
    ...claim, supportCount: 40, contradictCount: 0, observedEffect: -0.2,
    validated: true, lastObservedAt: new Date().toISOString(), ...over,
  });

  it('is exactly 1 when nothing applies, so the fallback is the old behaviour', () => {
    expect(calibrationFor([], 'contextBudget', { taskClass: 'debugging' }, Date.now())).toBe(1);
    expect(calibrationFor([active()], 'softTurnTarget', { taskClass: 'debugging' }, Date.now())).toBe(1);
  });

  it('nudges toward the recommendation without ever reaching it on partial evidence', () => {
    const factor = calibrationFor([active()], 'contextBudget', { taskClass: 'debugging' }, Date.now());
    expect(factor).toBeLessThan(1);
    expect(factor).toBeGreaterThan(0.8);
  });

  it('never moves a field that is a constraint', () => {
    const lesson = { ...active(), recommendation: { field: 'spendCapUsd', multiplier: 5 }, status: 'ACTIVE' as const };
    expect(calibrationFor([lesson], 'spendCapUsd', { taskClass: 'debugging' }, Date.now())).toBe(1);
  });
});

describe('triggerSimilarity', () => {
  it('counts an unmentioned key against the match rather than for it', () => {
    expect(triggerSimilarity({ a: '1', b: '2' }, { a: '1' })).toBe(0.5);
    expect(triggerSimilarity({ a: '1' }, { a: '1' })).toBe(1);
    expect(triggerSimilarity({}, {})).toBe(1);
  });
});

describe('observing runs', () => {
  it('accumulates one lesson across runs rather than one per run', () => {
    const db = createDb(TEST_DB);
    for (let i = 0; i < 5; i++) observe(db, { ...claim, supported: true, observedEffect: -0.1 });
    const lessons = listLessons(db);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].supportCount).toBe(5);
    expect(lessons[0].status).toBe('VALIDATING');
  });

  it('cannot activate a lesson from production observations alone', () => {
    const db = createDb(TEST_DB);
    let lesson = observe(db, { ...claim, supported: true, observedEffect: -0.1 });
    for (let i = 0; i < 30; i++) lesson = observe(db, { ...claim, supported: true, observedEffect: -0.1 });
    expect(lesson.status).toBe('SHADOW');
    // And the validation door refuses thin evidence even when asked directly.
    expect(activate(db, lesson.id, { source: 'benchmark', validRuns: SUPPORT_TO_SHADOW - 1 })).toBeNull();
    const activated = activate(db, lesson.id, { source: 'benchmark', validRuns: SUPPORT_TO_SHADOW });
    expect(activated?.status).toBe('ACTIVE');
  });

  it('retires a claim once the run stops agreeing with it', () => {
    const db = createDb(TEST_DB);
    for (let i = 0; i < 6; i++) observe(db, { ...claim, supported: true, observedEffect: -0.1 });
    let lesson = listLessons(db)[0];
    for (let i = 0; i < 4; i++) lesson = observe(db, { ...claim, supported: false, observedEffect: 0.3 });
    expect(lesson.status).toBe('RETIRED');
  });
});
