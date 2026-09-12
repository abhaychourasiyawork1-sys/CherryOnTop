import { describe, it, expect, afterEach } from 'vitest';
import { buildPlanPrompt, parseSubgoals } from './plan.js';
import { buildRolePrompt } from '../prompts/roles.js';

afterEach(() => { delete process.env.ORG_MAX_CHILD_JOBS; });

describe('buildPlanPrompt', () => {
  it('carries the goal and the number of agents available', () => {
    process.env.ORG_MAX_CHILD_JOBS = '5';
    const prompt = buildPlanPrompt('Review the cart module', 3);
    expect(prompt).toContain('Review the cart module');
    expect(prompt).toContain('up to 3 independent agents');
  });

  it('asks for at most two agents by default, however much authority there is', () => {
    // A fan-out is capped at the default child count, not at the node's
    // authority: five children on a broad goal mostly re-read the same
    // repository and cost five times one execution to do it.
    expect(buildPlanPrompt('x', 99)).toContain('up to 2 independent agents');
    expect(buildPlanPrompt('x', 0)).toContain('up to 1 independent agents');
  });

  it('lets a deployment raise the cap deliberately', () => {
    process.env.ORG_MAX_CHILD_JOBS = '4';
    expect(buildPlanPrompt('x', 99)).toContain('up to 4 independent agents');
  });
});

describe('buildRolePrompt(\'plan\')', () => {
  it('forbids doing the work during planning', () => {
    // The prohibition moved into the cached `plan` system stanza; the user
    // prompt no longer repeats it, but the planner is still told.
    expect(buildRolePrompt('plan')).toContain('Do not make any changes');
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
    process.env.ORG_MAX_CHILD_JOBS = '3';
    const text = 'Example: ["a", "b"]\n\nMy plan: ["Audit auth", "Add cart tests", "Fix the README"]';
    expect(parseSubgoals(text, 3)).toEqual(['Audit auth', 'Add cart tests', 'Fix the README']);
  });

  it('clamps a longer plan to the default child cap', () => {
    // The planner is asked for at most two, but nothing stops a model from
    // returning more; the cap has to hold on the way back in as well.
    expect(parseSubgoals('["a","b","c","d"]', 99)).toEqual(['a', 'b']);
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
