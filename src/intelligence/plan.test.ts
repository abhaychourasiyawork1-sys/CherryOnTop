import { describe, it, expect, afterEach } from 'vitest';
import { buildPlanPrompt, parsePlan, parseSubgoals } from './plan.js';
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

describe('buildPlanPrompt: one problem is one unit', () => {
  it('still forbids splitting a bug report into phases', () => {
    // A seaborn bug report was split into "investigate" and "implement".
    expect(buildPlanPrompt('Legend values are wrong for large ranges', 3))
      .toContain('One bug report or one question is a single unit of work');
  });

  it('allows a feature to split into research followed by the build', () => {
    // The webpage redesign was vetoed because the phase rule applied to every
    // goal, and the plan format had no way to say "build after research".
    const prompt = buildPlanPrompt('Redesign the landing page', 3);
    expect(prompt).toContain('"after"');
    expect(prompt).toContain('followed by the build that uses it');
  });

  it('takes [] off the table once the split is settled', () => {
    expect(buildPlanPrompt('x', 3)).toContain('Reply with exactly []');
    const forced = buildPlanPrompt('x', 3, { mustSplit: true });
    expect(forced).not.toContain('Reply with exactly []');
    expect(forced).toContain('how, not whether');
  });
});

describe('parsePlan: ordered pieces', () => {
  it('reads strings and {goal, after} entries together', () => {
    process.env.ORG_MAX_CHILD_JOBS = '3';
    const text = 'Here is the plan:\n```json\n["Research the product", "Research design references", {"goal": "Build the page", "after": [0, 1]}]\n```';
    expect(parsePlan(text, 3)).toMatchObject({
      subgoals: ['Research the product', 'Research design references', 'Build the page'],
      after: [[], [], [0, 1]],
    });
  });

  it('drops forward, self and dangling references, so the graph is acyclic', () => {
    process.env.ORG_MAX_CHILD_JOBS = '3';
    const text = '[{"goal": "a", "after": [1]}, {"goal": "b", "after": [1, 7, "0"]}, {"goal": "c", "after": [0, 0]}]';
    expect(parsePlan(text, 3).after).toEqual([[], [], [0]]);
  });

  it('remaps indexes past a blank entry the planner emitted', () => {
    process.env.ORG_MAX_CHILD_JOBS = '3';
    expect(parsePlan('["a", "  ", {"goal": "c", "after": [2, 0]}]', 3))
      .toMatchObject({ subgoals: ['a', 'c'], after: [[], [0]] });
  });

  it('drops references to pieces cut by the child cap', () => {
    expect(parsePlan('["a", "b", {"goal": "c", "after": [1]}]', 2))
      .toMatchObject({ subgoals: ['a', 'b'], after: [[], []] });
  });
});

describe('parsePlan: what the parent will require of each piece', () => {
  const plan = (entries: unknown[]) => parsePlan(JSON.stringify(entries), 4);

  it('reads a piece\'s own definition of done and the checks that prove it', () => {
    const parsed = plan([
      { goal: 'Build the cart', done: ['cart renders', 'cart persists'], checks: ['npm test -- cart', 'file:src/cart.tsx'] },
      { goal: 'Write the docs', done: ['docs build'] },
    ]);
    expect(parsed.definitionOfDone).toEqual([['cart renders', 'cart persists'], ['docs build']]);
    expect(parsed.acceptanceChecks).toEqual([['npm test -- cart', 'file:src/cart.tsx'], []]);
  });

  it('stays aligned with subgoals, empty where the planner said nothing — plain strings still work', () => {
    const parsed = plan(['Audit auth', 'Add cart tests']);
    expect(parsed.subgoals).toHaveLength(2);
    expect(parsed.definitionOfDone).toEqual([[], []]);
    expect(parsed.acceptanceChecks).toEqual([[], []]);
  });

  it('admits only checks the runtime can actually evidence: a verifying command or a file', () => {
    // Acceptance is met by evidence alone. "The cart renders correctly" can never
    // be evidenced, so admitting it would fail every piece until it escalated.
    const parsed = plan([
      { goal: 'Build the cart', checks: ['the cart renders correctly', 'npm test', 'it should be fast', 'file:src/cart.tsx', 'echo done', 'pytest tests/cart'] },
      'Write the docs',
    ]);
    expect(parsed.acceptanceChecks[0]).toEqual(['npm test', 'file:src/cart.tsx', 'pytest tests/cart']);
  });

  it('refuses a file check that points outside the workspace', () => {
    const parsed = plan([{ goal: 'a', checks: ['file:../secrets.env', 'file:/etc/passwd', 'file:src/ok.ts'] }, 'b']);
    expect(parsed.acceptanceChecks[0]).toEqual(['file:src/ok.ts']);
  });

  it('bounds what a planner can ask for', () => {
    const many = Array.from({ length: 20 }, (_, i) => `npm test -- case${i}`);
    const parsed = plan([{ goal: 'a', done: Array.from({ length: 20 }, (_, i) => `item ${i} ${'x'.repeat(500)}`), checks: many }, 'b']);
    expect(parsed.acceptanceChecks[0]).toHaveLength(3);
    expect(parsed.definitionOfDone[0]).toHaveLength(5);
    expect(parsed.definitionOfDone[0][0].length).toBeLessThanOrEqual(200);
  });

  it('accepts a single string where a list was expected, and ignores junk types', () => {
    const parsed = plan([{ goal: 'a', done: 'one thing', checks: 'npm test' }, { goal: 'b', done: 7, checks: [1, null, 'npm test'] }]);
    expect(parsed.definitionOfDone).toEqual([['one thing'], []]);
    expect(parsed.acceptanceChecks).toEqual([['npm test'], ['npm test']]);
  });

  it('keeps the contracts of the pieces that survive the child cap, and drops the rest', () => {
    const parsed = parsePlan(JSON.stringify([
      { goal: 'a', checks: ['npm test'] }, { goal: 'b', checks: ['npm run lint'] }, { goal: 'c', checks: ['npm run build'] },
    ]), 2);
    expect(parsed.subgoals).toEqual(['a', 'b']);
    expect(parsed.acceptanceChecks).toEqual([['npm test'], ['npm run lint']]);
  });

  it('asks the planner for them, and tells it not to invent a check it cannot name', () => {
    const prompt = buildPlanPrompt('Build the cart and the docs', 3);
    expect(prompt).toContain('"done"');
    expect(prompt).toContain('"checks"');
    expect(prompt).toMatch(/only when a (concrete )?command or file proves/i);
  });
});
