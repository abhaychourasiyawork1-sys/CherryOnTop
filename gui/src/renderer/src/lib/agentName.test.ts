import { describe, it, expect } from 'vitest';
import { agentName } from './agentName.js';

describe('naming an agent', () => {
  it('prefers a path, because that is how people refer to the work', () => {
    expect(agentName('Review src/db/queries/cases.ts and src/db/queries/dod.ts for bugs'))
      .toBe('src/db/queries/cases.ts');
  });

  it('strips the instruction verb to leave what the work is about', () => {
    expect(agentName('Review the persistence and domain-schema layer of this repo', 60))
      .toBe('persistence and domain-schema layer of this repo');
    expect(agentName('Add tests covering the cart discount edge cases', 60))
      .toBe('tests covering the cart discount edge cases');
  });

  it('strips the reporting boilerplate every sibling repeats', () => {
    // Observed live: five agents whose names differed only after 120 characters.
    expect(agentName('Review the k8s client, and produce a markdown table with columns: Module | Line | Issue'))
      .toBe('k8s client');
  });

  it('handles the read-only audit prefix the planner likes', () => {
    expect(agentName('Read-only audit: In this repo, compare the schema against migrations', 80))
      .toBe('In this repo, compare the schema against migrations');
  });

  it('never breaks a word in half', () => {
    const goal = 'Investigate the extraordinarily complicated authentication subsystem';
    const name = agentName(goal, 30);
    expect(name.endsWith('…')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(30);
    // What "not broken" means: every word kept is a whole word of the original.
    const kept = name.slice(0, -1).trim();
    expect(goal.split(/\s+/)).toEqual(expect.arrayContaining(kept.split(' ')));
  });

  it('keeps a long path readable from its end, where the filename is', () => {
    const name = agentName('Review src/very/deeply/nested/directory/structure/module.ts', 24);
    expect(name.startsWith('…')).toBe(true);
    expect(name).toContain('module.ts');
    expect(name.length).toBeLessThanOrEqual(24);
  });

  it('falls back to something rather than nothing', () => {
    expect(agentName('')).toBe('Agent');
    expect(agentName('   ')).toBe('Agent');
    // A goal that is only an instruction verb still has to name something.
    expect(agentName('Review')).toBe('Review');
  });

  it('collapses newlines, so a multi-line goal is still one name', () => {
    expect(agentName('Review the\n  parser\n  module')).toBe('parser module');
  });
});
