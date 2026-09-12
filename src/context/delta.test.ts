import { describe, it, expect } from 'vitest';
import { diffProjections, isNoOp, deltaSize, renderDelta, EMPTY_DELTA } from './delta.js';
import type { ContextRef } from './types.js';

const ref = (id: string, hash: string, version = 1): ContextRef => ({ semanticId: id, version, contentHash: hash });

describe('diffing two projections', () => {
  it('is a no-op when nothing moved', () => {
    const projection = [ref('a', 'h1'), ref('b', 'h2')];
    const delta = diffProjections(projection, projection);
    expect(isNoOp(delta)).toBe(true);
    expect(delta.unchanged).toHaveLength(2);
    expect(renderDelta(delta)).toBe('');
  });

  it('separates added from changed, because they call for different words', () => {
    // An agent told a file *changed* knows to re-read it; one told it was
    // *added* knows it is new. Collapsing them loses the only thing a delta was
    // for.
    const delta = diffProjections(
      [ref('a', 'h1')],
      [ref('a', 'h2', 2), ref('b', 'h3')],
    );
    expect(delta.changed).toEqual([{ from: ref('a', 'h1'), to: ref('a', 'h2', 2) }]);
    expect(delta.added.map((r) => r.semanticId)).toEqual(['b']);
    expect(delta.removed).toEqual([]);
  });

  it('reports what fell out of the projection', () => {
    const delta = diffProjections([ref('a', 'h1'), ref('b', 'h2')], [ref('a', 'h1')]);
    expect(delta.removed.map((r) => r.semanticId)).toEqual(['b']);
    expect(delta.unchanged.map((r) => r.semanticId)).toEqual(['a']);
  });

  it('sizes itself so a caller can tell a delta from a rewrite', () => {
    // For a wholesale change the delta is the projection plus overhead, and
    // sending it as a delta is worse than sending it plainly.
    const wholesale = diffProjections([ref('a', 'h1')], [ref('x', 'h9'), ref('y', 'h8')]);
    expect(deltaSize(wholesale)).toBe(3);
    expect(deltaSize(EMPTY_DELTA)).toBe(0);
  });

  it('renders only what moved, and tells the agent what to do about it', () => {
    const text = renderDelta(diffProjections([ref('a', 'h1'), ref('c', 'h4')], [ref('a', 'h2', 2), ref('b', 'h3')]));
    expect(text).toMatch(/changed: a/);
    expect(text).toMatch(/re-read it/);
    expect(text).toMatch(/added: b/);
    expect(text).toMatch(/no longer relevant: c/);
    // The unchanged part is not mentioned at all — that is the saving.
    expect(text).not.toMatch(/unchanged/);
  });
});
