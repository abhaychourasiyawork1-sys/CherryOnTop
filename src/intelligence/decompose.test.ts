import { describe, it, expect, afterEach } from 'vitest';
import { assessDecomposition } from './decompose.js';

const of = (goal: string) => assessDecomposition(goal);

describe('deciding whether work needs splitting at all', () => {
  it('does not split a single job, however wordily it is described', () => {
    // The old rule looked at length alone, so this went off to delegate and paid
    // for a planning sandbox to be told it does not split.
    const wordy = of(
      'Please take a careful look at the discount calculation inside src/billing.ts, '
      + 'because I believe the percentage is being applied before tax rather than after, '
      + 'and correct it so the totals come out right for the annual plans.',
    );
    expect(wordy.worthSplitting).toBe(false);
    expect(wordy.complexity).toBe('low');
  });

  // A coherent global task is the case that cost a measured run 26% of a
  // five-hour usage window: the word "codebase" alone scored 2, crossed the
  // split threshold, and bought a planner plus five sonnet children to answer
  // one question. Breadth makes a goal big, not divisible.
  describe('coherent global tasks stay one execution', () => {
    const cases = [
      'Review the codebase and find bugs. Do not modify anything.',
      'Audit the repository for security issues',
      'Understand why the application is slow',
      'Analyze the architecture and identify flaws',
      'Investigate the root cause of this bug',
      'Audit every module for bugs',
      'Debug the failure across all services',
    ];
    for (const goal of cases) {
      it(`does not split: ${goal}`, () => {
        expect(of(goal).worthSplitting).toBe(false);
      });
    }

    it('keeps them on the strong model even though they do not split', () => {
      // The whole point of scoring difficulty separately: `modelChoiceFor`
      // routes on this complexity, so collapsing a broad review to "low" would
      // quietly demote a whole-codebase bug hunt to the fast tier.
      expect(of('Review all services across the codebase').complexity).toBe('high');
      expect(of('Review the codebase and find bugs. Do not modify anything.').complexity)
        .not.toBe('low');
    });
  });

  it('flags investigative work, so routing does not cheapen a diagnosis', () => {
    expect(of('Investigate the root cause of this bug').investigative).toBe(true);
    expect(of('Review the codebase and find bugs. Do not modify anything.').investigative).toBe(true);
    expect(of('Understand why the application is slow').investigative).toBe(true);
    expect(of('Rename the variable').investigative).toBe(false);
  });

  it('still splits genuinely independent workstreams', () => {
    const multi = of('Fix authentication, optimize the DB query layer, update the frontend, and add API tests');
    expect(multi.worthSplitting).toBe(true);
    expect(multi.complexity).toBe('high');
  });

  it('obeys an explicit request to parallelise, whatever the scope reads like', () => {
    // Scope inference must not overrule the user saying so in words.
    expect(of('Review the codebase in parallel across several agents').worthSplitting).toBe(true);
    expect(of('Split this across multiple agents: audit the repo').worthSplitting).toBe(true);
  });

  it('splits several distinct deliverables in one request', () => {
    expect(of('Add tests for the parser; also document the public API').worthSplitting).toBe(true);
  });

  it('splits an explicit list', () => {
    expect(of('Do the following:\n- refactor the client\n- add tests\n- update the docs').worthSplitting).toBe(true);
  });

  it('keeps a named file as one job even when several verbs appear', () => {
    expect(of('Refactor and add tests for src/parser.ts only').worthSplitting).toBe(false);
  });

  it('treats one plain instruction as one job', () => {
    expect(of('Fix the typo in the README').worthSplitting).toBe(false);
    expect(of('Rename the variable').complexity).toBe('low');
  });

  it('names every signal it used, so a wrong call is inspectable', () => {
    const result = of('Audit every module and add tests');
    expect(Object.keys(result.signals)).toEqual([
      'breadth_terms', 'separate_items', 'distinct_work_types',
      'named_single_targets', 'decomposition_score',
      // Why it did or did not split, separately from how hard it judged the
      // work — the two were one number, and that was the bug.
      'split_score', 'coherent_single_task', 'explicit_split_request',
    ]);
    expect(result.signals.breadth_terms).toBeGreaterThan(0);
  });

  it('handles an empty goal without throwing', () => {
    expect(of('').worthSplitting).toBe(false);
  });
});

describe('the rollout switch', () => {
  afterEach(() => { delete process.env.ORG_EFFICIENCY_MODE; });

  it('keeps the old breadth-splits rule when efficiency is disabled', () => {
    // The before arm of `bench/run.mjs efficiency` has to be the exact prior
    // behaviour, or the comparison measures two different things.
    process.env.ORG_EFFICIENCY_MODE = 'disabled';
    expect(of('Review the codebase and find bugs. Do not modify anything.').worthSplitting).toBe(true);
  });

  it('records the new signals even in shadow mode, where it does not act on them', () => {
    process.env.ORG_EFFICIENCY_MODE = 'shadow';
    const shadow = of('Review the codebase and find bugs. Do not modify anything.');
    expect(shadow.worthSplitting).toBe(true);
    expect(shadow.signals.coherent_single_task).toBe(1);
  });
});
