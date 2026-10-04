import { describe, it, expect } from 'vitest';
import { findSymbolBody, extractLines, describeExcerpt, MAX_SYMBOL_LINES } from './materializer.js';

const TS = [
  "import { helper } from './helper.js';",   // 1
  '',                                         // 2
  '/** Refreshes a session. */',              // 3
  'export function refreshSession(id: string) {', // 4
  "  const label = 'a } in a string';",       // 5
  '  if (id) {',                              // 6
  '    return helper(id);',                   // 7
  '  }',                                      // 8
  '  return null; // trailing }',             // 9
  '}',                                        // 10
  '',                                         // 11
  'export function other() {',                // 12
  '  return 1;',                              // 13
  '}',                                        // 14
].join('\n');

describe('targeted symbol extraction', () => {
  it('finds a function body through nested braces, strings and comments, with its doc comment', () => {
    const body = findSymbolBody(TS, 'refreshSession')!;
    expect(body.from).toBe(3);
    expect(body.to).toBe(10);
    expect(body.text.split('\n')).toHaveLength(8);
    expect(body.text).toContain('return helper(id);');
    expect(body.text).not.toContain('other');
    expect(body.totalLines).toBe(14);
  });

  it('does not stop at a brace inside a return type', () => {
    const src = ['export function shape(): { a: number } {', '  return { a: 1 };', '}', 'const after = 1;'].join('\n');
    expect(findSymbolBody(src, 'shape')!.to).toBe(3);
  });

  it('finds a class as one unit', () => {
    const src = ['export class Session {', '  refresh() {', '    return 1;', '  }', '}', 'export const z = 1;'].join('\n');
    const body = findSymbolBody(src, 'Session')!;
    expect([body.from, body.to]).toEqual([1, 5]);
  });

  it('finds an arrow function assigned to a const, with and without braces', () => {
    const braces = ['export const load = async (id: string) => {', '  return id;', '};', 'x();'].join('\n');
    expect(findSymbolBody(braces, 'load')!.to).toBe(3);
    const oneLine = ['export const twice = (n: number) => n * 2;', 'const other = 1;'].join('\n');
    const body = findSymbolBody(oneLine, 'twice')!;
    expect([body.from, body.to]).toEqual([1, 1]);
  });

  it('follows indentation for Python and keeps the decorator', () => {
    const py = ['import os', '', '@cached', 'def refresh(session):', '    """Doc."""', '    if session:', '        return 1', '', '    return 2', '', 'def other():', '    pass'].join('\n');
    const body = findSymbolBody(py, 'refresh')!;
    expect([body.from, body.to]).toEqual([3, 9]);
    expect(body.text).not.toContain('other');
  });

  it('finds a Ruby method by its matching end', () => {
    const rb = ['def refresh', '  if x', '    1', '  end', 'end', 'def other', 'end'].join('\n');
    expect(findSymbolBody(rb, 'refresh')!.to).toBe(5);
  });

  it('returns null for a symbol that is not declared, rather than guessing', () => {
    expect(findSymbolBody(TS, 'missing')).toBeNull();
    expect(findSymbolBody(TS, 'ref')).toBeNull(); // a prefix is not a match
  });

  it('returns null when braces never balance, rather than a runaway excerpt', () => {
    expect(findSymbolBody('export function broken() {\n  if (x) {\n    y();\n', 'broken')).toBeNull();
  });

  it('refuses a body larger than it is willing to call an excerpt', () => {
    const big = ['export function huge() {', ...Array.from({ length: MAX_SYMBOL_LINES + 10 }, () => '  work();'), '}'].join('\n');
    expect(findSymbolBody(big, 'huge')).toBeNull();
  });

  it('takes the first declaration when a name is declared twice', () => {
    const src = ['function dup() {', '  return 1;', '}', 'function dup() {', '  return 2;', '}'].join('\n');
    expect(findSymbolBody(src, 'dup')!.text).toContain('return 1');
  });

  it('does not mistake a call site or a comment for the declaration', () => {
    const src = ['// refresh() is called below', 'refresh();', 'function refresh() {', '  return 1;', '}'].join('\n');
    expect(findSymbolBody(src, 'refresh')!.from).toBe(3);
  });
});

describe('line ranges', () => {
  it('extracts an inclusive 1-based range', () => {
    const r = extractLines(TS, 12, 14)!;
    expect(r.text).toBe(['export function other() {', '  return 1;', '}'].join('\n'));
    expect([r.from, r.to]).toEqual([12, 14]);
  });

  it('clamps to the file and rejects an empty or inverted range', () => {
    expect(extractLines(TS, 13, 999)!.to).toBe(14);
    expect(extractLines(TS, 0, 2)!.from).toBe(1);
    expect(extractLines(TS, 20, 30)).toBeNull();
    expect(extractLines(TS, 5, 4)).toBeNull();
  });
});

describe('saying what was and was not sent', () => {
  it('labels an excerpt as part of a file, with where it came from', () => {
    const text = describeExcerpt('src/auth.ts', findSymbolBody(TS, 'refreshSession')!, 'refreshSession');
    expect(text).toContain('src/auth.ts');
    expect(text).toContain('lines 3-10 of 14');
    expect(text).toContain('refreshSession');
    expect(text).toMatch(/rest of the file was not sent/i);
  });
});
