import { describe, it, expect } from 'vitest';
import { resolveIntent, goalWithContext, redirectGoal, addRef, parseDroppedRef } from './ContextResolver.js';

describe('composer intent', () => {
  it('a question about a run does not start work', () => {
    expect(resolveIntent('why did it delegate?', { hasCase: true, runLive: false })).toBe('question');
    expect(resolveIntent('what is blocking this', { hasCase: true, runLive: true })).toBe('question');
  });

  it('with nothing on record, even a question-shaped goal is work', () => {
    expect(resolveIntent('why is the build slow? fix it', { hasCase: false, runLive: false })).toBe('work');
  });

  it('suggests redirection only while a run is live', () => {
    expect(resolveIntent('Actually, keep the old token format', { hasCase: true, runLive: true })).toBe('redirect');
    expect(resolveIntent('Actually, keep the old token format', { hasCase: true, runLive: false })).toBe('work');
    expect(resolveIntent('Add a cache', { hasCase: true, runLive: true })).toBe('work');
  });
});

describe('context', () => {
  const file = { kind: 'file' as const, id: '/workspace/a.ts', label: 'a.ts' };

  it('states pointed-at context explicitly in the goal', () => {
    expect(goalWithContext('Fix it', [])).toBe('Fix it');
    expect(goalWithContext('Fix it', [file, { kind: 'decision', id: 'd1', label: 'Split' }]))
      .toBe('Fix it\n\nContext:\n- file: a.ts\n- decision: Split (d1)');
  });

  it('records what a redirect replaced', () => {
    expect(redirectGoal('Use JWT', { id: 'r1', title: 'Auth' })).toContain('redirects run r1 ("Auth")');
  });

  it('drops add a reference once, and reject junk', () => {
    expect(addRef(addRef([], file), file)).toHaveLength(1);
    expect(parseDroppedRef(JSON.stringify(file))).toEqual(file);
    expect(parseDroppedRef('{"kind":"virus","id":"x","label":"y"}')).toBeNull();
    expect(parseDroppedRef('nope')).toBeNull();
  });
});
