import { describe, it, expect } from 'vitest';
import { ToolResultStore, resultUri, MIN_STORED_CHARS } from './result-store.js';

const big = (n: number, word = 'line') => Array.from({ length: n }, (_, i) => `${word} ${i + 1}`).join('\n');

describe('ToolResultStore', () => {
  it('keeps substantial outputs under a stable result:// reference with size, checksum and preview', () => {
    const s = new ToolResultStore();
    expect(s.put({ id: 't0', tool: 'Bash', text: 'small' })).toBeUndefined();
    const ref = s.put({ id: 'toolu_01/x', tool: 'Bash', target: 'make test', text: big(500) })!;
    expect(ref.uri).toBe('result://toolu_01x');
    expect(ref).toMatchObject({ tool: 'Bash', target: 'make test', lines: 500 });
    expect(ref.checksum).toMatch(/^[0-9a-f]{16}$/);
    expect(ref.preview.startsWith('line 1\nline 2')).toBe(true);
    expect(s.ref('toolu_01/x')).toBe(ref);
    expect(s.ref(ref.uri)).toBe(ref);
    expect(s.content(ref.uri)).toBe(big(500));
  });

  it('fetches a numbered line range, or only the lines matching a pattern', () => {
    const s = new ToolResultStore();
    s.put({ id: 'a', tool: 'Bash', target: 'pytest', text: `${big(300)}\nFAILED test_x - assert 1 == 2\n${big(10, 'tail')}` });
    const range = s.fetch('result://a', { offset: 10, limit: 3 });
    expect(range.found).toBe(true);
    expect(range.text.split('\n').slice(1)).toEqual(['10\tline 10', '11\tline 11', '12\tline 12']);
    expect(range.text.split('\n')[0]).toMatch(/lines 10–12 of 311/);
    const hits = s.fetch('a', { pattern: 'FAILED|assert' });
    expect(hits.text).toContain('301\tFAILED test_x - assert 1 == 2');
    expect(hits.text).toMatch(/1 line match/);
    expect(s.fetch('a', { pattern: '(' }).found).toBe(false);
  });

  it('bounds an answer at a line boundary and says where to continue', () => {
    const s = new ToolResultStore();
    s.put({ id: 'a', tool: 'Bash', text: big(5000) });
    const r = s.fetch('a', { maxChars: 2_000 });
    expect(r.text.length).toBeLessThan(2_100);
    expect(r.text).toMatch(/answer limit reached at line \d+; fetch again with offset \d+/);
  });

  it('says plainly when a reference is unknown', () => {
    const r = new ToolResultStore().fetch('result://nope');
    expect(r).toMatchObject({ found: false });
    expect(r.text).toMatch(/No result is stored/);
  });

  it('holds identical content once, whichever call produced it', () => {
    const s = new ToolResultStore();
    const text = big(400);
    const a = s.put({ id: 'a', tool: 'Bash', text })!;
    const b = s.put({ id: 'b', tool: 'Grep', text })!;
    expect(a.checksum).toBe(b.checksum);
    expect(s.stats()).toMatchObject({ stored: 2, storedChars: text.length, deduped: 1 });
  });

  it('evicts the oldest contents past its bound, keeping metadata and pointing at a saved copy', () => {
    const s = new ToolResultStore(3 * MIN_STORED_CHARS);
    const text = (c: string) => c.repeat(MIN_STORED_CHARS * 2);
    s.put({ id: 'old', tool: 'Bash', text: text('a'), spilledTo: '/tmp/cto-ic/old.out' });
    s.put({ id: 'new', tool: 'Bash', text: text('b') });
    expect(s.has('old')).toBe(false);
    expect(s.has('new')).toBe(true);
    const r = s.fetch('old');
    expect(r.found).toBe(false);
    expect(r.text).toMatch(/no longer held.*\/tmp\/cto-ic\/old\.out/);
    expect(s.stats().evicted).toBe(1);
    s.evictTo(0);
    expect(s.has('new')).toBe(false);
  });

  it('counts what recovery cost', () => {
    const s = new ToolResultStore();
    s.put({ id: 'a', tool: 'Bash', text: big(300) });
    s.fetch('a', { limit: 5 });
    s.fetch('missing');
    expect(s.stats().fetches).toBe(2);
    expect(s.stats().fetchedTokens).toBeGreaterThan(0);
    expect(resultUri('x y')).toBe('result://xy');
  });
});
