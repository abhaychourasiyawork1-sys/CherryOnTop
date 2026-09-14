/** The regime suite as data, checked.
 *
 *  A benchmark corpus is a claim about coverage, and a claim about coverage
 *  that nothing checks drifts the moment somebody adds a goal in a hurry. These
 *  assert the properties `regimes.md` says the suite has. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const fixtures = JSON.parse(readFileSync(new URL('../goals.json', import.meta.url)));

const REGIMES = [
  'information-rich', 'information-poor', 'hidden-dependency', 'exploration-trap',
  'strategy-failure', 'hard-budget', 'shared-information', 'novel',
];

describe('the regime suite', () => {
  it('covers every regime the architecture claims to handle', () => {
    expect([...new Set(fixtures.regimes.map((g) => g.regime))].sort()).toEqual([...REGIMES].sort());
  });

  it('has at least three tasks in each', () => {
    for (const regime of REGIMES) {
      expect(fixtures.regimes.filter((g) => g.regime === regime).length, regime)
        .toBeGreaterThanOrEqual(3);
    }
  });

  it('varies the task family within a regime, so a policy tuned to one does not score as handling the regime', () => {
    for (const regime of REGIMES) {
      const tasks = fixtures.regimes.filter((g) => g.regime === regime);
      const distinct = new Set(tasks.map((g) => `${g.family}:${g.size}`));
      expect(distinct.size, regime).toBeGreaterThan(1);
    }
  });

  it('gives every task a rubric and an expectation', () => {
    for (const task of fixtures.regimes) {
      expect(task.rubric, task.id).toBeTruthy();
      // What the regime is testing, in the task itself — so a result can be
      // read without holding regimes.md open beside it.
      expect(task.expectation, task.id).toBeTruthy();
    }
  });

  it('gives every task a unique id', () => {
    const ids = fixtures.regimes.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not collide with the frozen population or the family set', () => {
    const frozen = new Set([...fixtures.goals, ...fixtures.families].map((g) => g.id));
    for (const task of fixtures.regimes) expect(frozen.has(task.id), task.id).toBe(false);
  });
});

describe('the specific situations the plan requires', () => {
  const inRegime = (regime) => fixtures.regimes.filter((g) => g.regime === regime);

  it('includes work where exploration is genuinely productive', () => {
    // A stuck-detector that counts searches stops exactly these runs.
    const productive = inRegime('exploration-trap')
      .filter((g) => /productive|terminating|new/i.test(g.expectation));
    expect(productive.length).toBeGreaterThanOrEqual(2);
  });

  it('includes work where the trap is real, so the two are distinguishable', () => {
    const trap = inRegime('exploration-trap').filter((g) => /nothing to find|does not exist/i.test(g.expectation));
    expect(trap.length).toBeGreaterThanOrEqual(1);
  });

  it('includes work where omitted context is expensive to rediscover', () => {
    expect(inRegime('hidden-dependency').length).toBeGreaterThanOrEqual(3);
    expect(inRegime('hidden-dependency').some((g) => /expensive to rediscover/i.test(g.expectation))).toBe(true);
  });

  it('includes work where extra context would be pure waste', () => {
    expect(inRegime('information-rich').some((g) => /pure waste/i.test(g.expectation))).toBe(true);
  });

  it('includes work with shared-information branches', () => {
    expect(inRegime('shared-information').length).toBeGreaterThanOrEqual(3);
  });

  it('includes work with a write conflict between branches that look independent', () => {
    expect(inRegime('shared-information').some((g) => /write the same file|neither branch expected/i.test(g.expectation)))
      .toBe(true);
  });

  it('includes work with a strategy-failure recovery opportunity', () => {
    expect(inRegime('strategy-failure').length).toBeGreaterThanOrEqual(3);
  });

  it('includes task shapes this runtime has no notion of', () => {
    expect(inRegime('novel').length).toBeGreaterThanOrEqual(3);
  });
});

describe('the frozen population stays frozen', () => {
  it('still has exactly the seven goals the recorded baseline was measured on', () => {
    // Adding one would silently change what "the baseline" means, and every
    // later comparison would be against a number no earlier run produced.
    expect(fixtures.goals.map((g) => g.id).sort()).toEqual([
      'add-test', 'audit', 'doc', 'global-investigation', 'global-review',
      'small-bug', 'typo-fix',
    ]);
  });

  it('says so in the file, where someone about to add one will read it', () => {
    expect(fixtures._note).toContain('do not add to it');
    expect(fixtures._regimes_note).toContain('off unless --regimes is passed');
  });
});
