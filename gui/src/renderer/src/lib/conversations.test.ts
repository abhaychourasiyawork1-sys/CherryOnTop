import { describe, it, expect } from 'vitest';
import { NONE, MAIN, createBranch, assign, casesIn, deleteBranch, branchConflicts, decodeConversations, renameBranch } from './conversations.js';

const all = ['c1', 'c2', 'c3'];

describe('conversations', () => {
  it('a new branch inherits the run it came from without taking it from Main', () => {
    const state = createBranch(NONE, 'Token format', 'c1', 'b1', '2026-09-01T00:00:00Z');
    expect(casesIn(state, 'b1', all)).toEqual(['c1']);
    expect(casesIn(state, MAIN, all)).toEqual(all);
  });

  it('runs asked in a branch leave Main, and nothing is duplicated', () => {
    let state = createBranch(NONE, 'x', null, 'b1', '');
    state = assign(state, 'b1', 'c2');
    state = assign(state, 'b1', 'c2');
    expect(casesIn(state, 'b1', all)).toEqual(['c2']);
    expect(casesIn(state, MAIN, all)).toEqual(['c1', 'c3']);
    expect(assign(state, MAIN, 'c3')).toBe(state);
  });

  it('is reversible: deleting a branch returns its runs to Main', () => {
    let state = assign(createBranch(NONE, 'x', null, 'b1', ''), 'b1', 'c2');
    state = deleteBranch(state, 'b1');
    expect(casesIn(state, MAIN, all)).toEqual(all);
    expect(renameBranch(createBranch(NONE, 'x', null, 'b', ''), 'b', '  ').branches[0].name).toBe('x');
  });

  it('two conversations changing the same file is a conflict to decide', () => {
    const state = assign(createBranch(NONE, 'x', null, 'b1', ''), 'b1', 'c2');
    const conflicts = branchConflicts(state, all, new Map([['c1', ['a.ts']], ['c2', ['a.ts', 'b.ts']], ['c3', ['b.ts']]]));
    expect(conflicts).toEqual([
      { file: 'a.ts', a: { branchId: MAIN, caseId: 'c1' }, b: { branchId: 'b1', caseId: 'c2' } },
      { file: 'b.ts', a: { branchId: MAIN, caseId: 'c3' }, b: { branchId: 'b1', caseId: 'c2' } },
    ]);
  });

  it('survives corrupt storage', () => {
    expect(decodeConversations('{')).toEqual(NONE);
    expect(decodeConversations(JSON.stringify({ version: 1, branches: [{ id: 1 }] }))).toEqual(NONE);
  });
});
