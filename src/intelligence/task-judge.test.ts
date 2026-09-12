import { describe, it, expect, afterEach } from 'vitest';
import { judgeTask, planningPaysForItself, PLANNING_COST_SHARE } from './task-judge.js';

afterEach(() => { delete process.env.ORG_EFFICIENCY_MODE; });

describe('the direct fast path', () => {
  it('does not plan a one-line edit', () => {
    // The whole apparatus for deciding how to divide work is itself work.
    const verdict = judgeTask('Fix the typo in the README');
    expect(verdict.taskClass).toBe('trivial_edit');
    expect(verdict.direct).toBe(true);
    expect(verdict.worthPlanning).toBe(false);
  });

  it('does not treat every short goal as trivial', () => {
    expect(judgeTask('Investigate the root cause of this bug').direct).toBe(false);
  });
});

describe('planning only when it could buy something', () => {
  it('refuses to plan a coherent goal, because the only answer is "it does not split"', () => {
    const verdict = judgeTask('Review the codebase and find bugs. Do not modify anything.');
    expect(verdict.worthPlanning).toBe(false);
    expect(verdict.reason).toMatch(/one coherent unit/);
  });

  it('plans genuinely separate workstreams', () => {
    const verdict = judgeTask('Fix authentication, optimise the DB query layer, and add API tests');
    expect(verdict.worthPlanning).toBe(true);
    expect(verdict.taskClass).toBe('multi_workstream');
  });

  it('keeps a goal that does not split eligible for the plan cache', () => {
    // "This does not split" is exactly as stable an answer as a split, and
    // exactly as expensive to recompute.
    expect(judgeTask('Review the codebase and find bugs').planCacheEligible).toBe(true);
  });
});

describe('classifying the kind of work', () => {
  it('separates the classes that call for different shapes of run', () => {
    expect(judgeTask('Investigate the root cause of this bug').taskClass).toBe('debugging');
    expect(judgeTask('Understand why the application is slow').taskClass).toBe('investigation');
    expect(judgeTask('Add a unit test for the discount logic').taskClass).toBe('test_authoring');
    expect(judgeTask('Document the node lifecycle states').taskClass).toBe('documentation');
    expect(judgeTask('Add a retry to the upload handler').taskClass).toBe('implementation');
    expect(judgeTask('Review the codebase in parallel across several agents').taskClass).toBe('multi_workstream');
  });

  it('does not let the class decide the model', () => {
    // Model choice routes on complexity, deliberately. A broad review is a
    // single investigation and still hard.
    const verdict = judgeTask('Review all services across the codebase');
    expect(verdict.taskClass).toBe('investigation');
    expect(verdict.decomposition.complexity).toBe('high');
  });
});

describe('whether planning pays for itself', () => {
  const verdict = judgeTask('Fix authentication, optimise the DB query layer, and add API tests');

  it('buys planning when it is a rounding error against the work it would enable', () => {
    // Measured: a planning dispatch was ~119k tokens. Against a fan-out of two
    // execute dispatches at 1.77M each, that is under 4%.
    expect(planningPaysForItself({ verdict, workTokens: 3_544_436, planningTokens: 118_787 })).toBe(true);
  });

  it('refuses when planning would cost a meaningful share of the work', () => {
    // Against a *single* dispatch, the same planner is 6.7% — which is exactly
    // why planning a goal that turns out not to split is a bad trade.
    expect(planningPaysForItself({ verdict, workTokens: 1_772_218, planningTokens: 118_787 })).toBe(false);
    expect(planningPaysForItself({ verdict, workTokens: 100_000, planningTokens: 50_000 })).toBe(false);
  });

  it('never buys planning for a goal that cannot split', () => {
    const coherent = judgeTask('Review the codebase and find bugs');
    expect(planningPaysForItself({ verdict: coherent, workTokens: 1_000_000, planningTokens: 1 })).toBe(false);
  });

  it('refuses rather than dividing by zero on a task with no measured cost', () => {
    expect(planningPaysForItself({ verdict, workTokens: 0, planningTokens: 0 })).toBe(false);
  });

  it('states its threshold rather than hiding it in an inequality', () => {
    expect(PLANNING_COST_SHARE).toBe(0.05);
  });
});
