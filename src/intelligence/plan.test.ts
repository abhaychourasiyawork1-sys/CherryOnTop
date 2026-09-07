import { describe, it, expect } from 'vitest';
import { buildPlanPrompt, parseSubgoals } from './plan.js';

describe('buildPlanPrompt', () => {
  it('carries the goal and the number of agents available', () => {
    const prompt = buildPlanPrompt('Review the cart module', 3);
    expect(prompt).toContain('Review the cart module');
    expect(prompt).toContain('up to 3 independent agents');
  });

  it('forbids doing the work during planning', () => {
    expect(buildPlanPrompt('x', 3)).toContain('Do NOT make any changes');
  });

  it('never asks for more agents than the runtime will run', () => {
    expect(buildPlanPrompt('x', 99)).toContain('up to 5 independent agents');
    expect(buildPlanPrompt('x', 0)).toContain('up to 1 independent agents');
  });
});

describe('parseSubgoals', () => {
  it('reads a plain JSON array', () => {
    expect(parseSubgoals('["Audit auth", "Add cart tests"]', 3))
      .toEqual(['Audit auth', 'Add cart tests']);
  });

  it('tolerates a code fence and surrounding prose', () => {
    const text = 'Here is the split:\n```json\n["Audit auth", "Add cart tests"]\n```\nHope that helps.';
    expect(parseSubgoals(text, 3)).toEqual(['Audit auth', 'Add cart tests']);
  });

  it('takes the answer, not the example the prompt showed', () => {
    const text = 'Example: ["a", "b"]\n\nMy plan: ["Audit auth", "Add cart tests", "Fix the README"]';
    expect(parseSubgoals(text, 3)).toEqual(['Audit auth', 'Add cart tests', 'Fix the README']);
  });

  it('caps the split at the agents actually available', () => {
    expect(parseSubgoals('["a","b","c","d"]', 2)).toEqual(['a', 'b']);
  });

  it('treats a single subgoal as no split at all', () => {
    // One subgoal is the original goal reworded. Delegating it is the clone
    // this module exists to prevent.
    expect(parseSubgoals('["Just do the whole thing"]', 3)).toEqual([]);
  });

  it('returns nothing when the goal does not split', () => {
    expect(parseSubgoals('[]', 3)).toEqual([]);
    expect(parseSubgoals('I could not split this.', 3)).toEqual([]);
    expect(parseSubgoals('', 3)).toEqual([]);
  });

  it('ignores malformed and non-string entries rather than passing them on', () => {
    expect(parseSubgoals('[not json', 3)).toEqual([]);
    expect(parseSubgoals('[1, 2, 3]', 3)).toEqual([]);
    expect(parseSubgoals('["real", 42, "  ", "also real"]', 3)).toEqual(['real', 'also real']);
  });
});
