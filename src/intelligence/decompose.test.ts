import { describe, it, expect } from 'vitest';
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

  it('splits work asked for across many things, however tersely', () => {
    // Terse but genuinely parallel — the old rule called this "low".
    expect(of('Audit every module for bugs').worthSplitting).toBe(true);
    expect(of('Review all services across the codebase').complexity).toBe('high');
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
    ]);
    expect(result.signals.breadth_terms).toBeGreaterThan(0);
  });

  it('handles an empty goal without throwing', () => {
    expect(of('').worthSplitting).toBe(false);
  });
});
