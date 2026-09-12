import { describe, it, expect } from 'vitest';
import { collapseDuplicates, headAndTail, keepMatching, reduceGeneric, unreduced } from './observation-reducer.js';

describe('collapsing duplicates', () => {
  it('is the highest-yield transform on real shell output', () => {
    const spinner = Array.from({ length: 500 }, () => 'resolving dependencies...').join('\n');
    const { text, collapsed } = collapseDuplicates(spinner);
    expect(text).toBe('resolving dependencies...   [× 500]');
    expect(collapsed).toBe(499);
  });

  it('keeps what the repetition told you', () => {
    // Lossless in meaning: the count is the information the repetition carried.
    expect(collapseDuplicates('a\na\nb').text).toBe('a   [× 2]\nb');
  });

  it('leaves output with no repetition alone', () => {
    const { text, collapsed } = collapseDuplicates('a\nb\nc');
    expect(text).toBe('a\nb\nc');
    expect(collapsed).toBe(0);
  });
});

describe('head and tail', () => {
  it('names the gap rather than silently dropping it', () => {
    // A truncated output that does not say it is truncated reads as a complete
    // one, which is worse than the tokens it saved.
    const long = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n');
    const reduction = headAndTail(long, 20);
    expect(reduction.text).toMatch(/980 lines omitted/);
    expect(reduction.text).toMatch(/kept as an artifact/);
    expect(reduction.text).toContain('line 0');
    expect(reduction.text).toContain('line 999');
    expect(reduction.strategy).toBe('truncate');
  });

  it('does nothing when the output already fits', () => {
    expect(headAndTail('a\nb', 20).reduced).toBe(false);
  });
});

describe('keeping only what carries the answer', () => {
  it('says so when nothing matched, rather than returning an empty string', () => {
    // An empty string reads as "the tool produced nothing", which is a
    // different and wrong fact.
    const reduction = keepMatching('a\nb\nc', () => false);
    expect(reduction.text).toMatch(/no lines matched/);
    expect(reduction.reduced).toBe(true);
  });

  it('reports no reduction when everything matched', () => {
    expect(keepMatching('a\nb', () => true).reduced).toBe(false);
  });
});

describe('the generic fallback', () => {
  it('collapses first and bounds second', () => {
    const noisy = [...Array.from({ length: 300 }, () => 'same'), ...Array.from({ length: 10 }, (_, i) => `unique ${i}`)].join('\n');
    const reduction = reduceGeneric(noisy, 60);
    expect(reduction.reduced).toBe(true);
    expect(reduction.text).toContain('[× 300]');
    expect(reduction.text.split('\n').length).toBeLessThanOrEqual(61);
  });

  it('leaves short, non-repetitive output exactly as it was', () => {
    expect(reduceGeneric('a\nb\nc', 60)).toEqual(unreduced('a\nb\nc'));
  });
});
