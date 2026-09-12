import { describe, it, expect } from 'vitest';
import { EMPTY_FRONTIER, updateFrontier, isClosed, closure } from './frontier.js';
import type { ContextRef } from './types.js';

const ref = (id: string, hash = 'h'): ContextRef => ({ semanticId: id, version: 1, contentHash: hash });

describe('the knowledge frontier', () => {
  it('starts closed, because nothing has been asked yet', () => {
    expect(isClosed(EMPTY_FRONTIER)).toBe(true);
    expect(closure(EMPTY_FRONTIER)).toBe(1);
  });

  it('opens when an observation reveals something still needed', () => {
    const after = updateFrontier(EMPTY_FRONTIER, { raised: [ref('a'), ref('b')] });
    expect(isClosed(after)).toBe(false);
    expect(after.unknown).toHaveLength(2);
  });

  it('closes a question by learning it, and does not keep it in both buckets', () => {
    const open = updateFrontier(EMPTY_FRONTIER, { raised: [ref('a'), ref('b')] });
    const after = updateFrontier(open, { learned: [ref('a')] });
    expect(after.known.map((r) => r.semanticId)).toEqual(['a']);
    expect(after.unknown.map((r) => r.semanticId)).toEqual(['b']);
  });

  it('closes a question by ruling it out — the bucket that lets evidence gathering stop', () => {
    // "Unknown" grows without bound in any real repository. A planner that only
    // tracks known-versus-unknown never terminates.
    const open = updateFrontier(EMPTY_FRONTIER, { raised: [ref('a'), ref('b')] });
    const after = updateFrontier(open, { learned: [ref('a')], ruledOut: [ref('b')] });
    expect(isClosed(after)).toBe(true);
    expect(after.unnecessary.map((r) => r.semanticId)).toEqual(['b']);
  });

  it('never re-raises something already settled', () => {
    // The loop this prevents: an evidence planner re-asking a closed question
    // every round, forever.
    const settled = updateFrontier(EMPTY_FRONTIER, { learned: [ref('a')], ruledOut: [ref('b')] });
    const after = updateFrontier(settled, { raised: [ref('a'), ref('b'), ref('c')] });
    expect(after.unknown.map((r) => r.semanticId)).toEqual(['c']);
  });

  it('distinguishes versions of the same identity', () => {
    const known = updateFrontier(EMPTY_FRONTIER, { learned: [ref('a', 'v1')] });
    const after = updateFrontier(known, { raised: [ref('a', 'v2')] });
    expect(after.unknown).toHaveLength(1);
  });

  it('reports how much of what was considered is settled, and does not act on it', () => {
    const frontier = updateFrontier(EMPTY_FRONTIER, { learned: [ref('a')], raised: [ref('b'), ref('c')] });
    expect(closure(frontier)).toBeCloseTo(1 / 3);
  });

  it('is a value, not a process — the same update twice changes nothing', () => {
    const once = updateFrontier(EMPTY_FRONTIER, { raised: [ref('a')] });
    expect(updateFrontier(once, { raised: [ref('a')] })).toEqual(once);
  });
});
