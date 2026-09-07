import { describe, it, expect } from 'vitest';
import { withConstraints } from './prompt.js';

describe('withConstraints', () => {
  it('leaves a goal alone when nothing was asked of it', () => {
    expect(withConstraints('fix the bug', [])).toBe('fix the bug');
    expect(withConstraints('fix the bug', ['  ', ''])).toBe('fix the bug');
  });

  it('states the instructions before the goal, and keeps the goal last', () => {
    const prompt = withConstraints('fix the bug', ['Do not touch the database']);
    expect(prompt).toContain('Do not touch the database');
    expect(prompt.trimEnd().endsWith('fix the bug')).toBe(true);
  });

  it('tells the agent to report a conflict rather than silently choosing', () => {
    expect(withConstraints('x', ['y'])).toContain('say so if one blocks you');
  });
});
