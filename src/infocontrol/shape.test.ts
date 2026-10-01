import { describe, it, expect } from 'vitest';
import { collapseRepeats, extractText, outlineView, salientView, shapeCandidates, termsOf } from './shape.js';

describe('extractText', () => {
  it('reads the tool response shapes Claude Code reports', () => {
    expect(extractText('plain')).toBe('plain');
    expect(extractText({ type: 'text', text: 'hello' })).toBe('hello');
    expect(extractText({ stdout: 'out', stderr: 'err', interrupted: false })).toBe('out\nerr');
    expect(extractText({ stdout: '', stderr: 'only err' })).toBe('only err');
    expect(extractText({ type: 'text', file: { filePath: '/a', content: '1\tx' } })).toBe('1\tx');
    expect(extractText({ filenames: ['a', 'b'], numFiles: 2 })).toBe('a\nb');
  });

  it('passes an unknown or errored shape through untouched (null)', () => {
    expect(extractText({ weird: 1 })).toBeNull();
    expect(extractText({ is_error: true, text: 'boom' })).toBeNull();
    expect(extractText(42)).toBeNull();
  });
});

describe('collapseRepeats', () => {
  it('folds runs of lines that differ only in digits', () => {
    const lines = ['start', ...Array.from({ length: 50 }, (_, i) => `Downloading ${i}%`), 'done'];
    const out = collapseRepeats(lines);
    expect(out.lines).toEqual(['start', 'Downloading 0%', '  … (48 similar lines) …', 'Downloading 49%', 'done']);
  });

  it('keeps short runs as they are', () => {
    expect(collapseRepeats(['a 1', 'a 2', 'a 3', 'b']).lines).toEqual(['a 1', 'a 2', 'a 3', 'b']);
  });
});

describe('salientView', () => {
  // Letters, not digits, vary between lines, so nothing collapses and the
  // middle must be chosen by salience.
  const word = (i: number) => String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + ((i * 7) % 26)) + String.fromCharCode(97 + ((i * 13) % 26));
  const log = Array.from({ length: 400 }, (_, i) => `noise line ${word(i)} nothing here`);
  log[200] = 'ERROR in parse_config: KeyError missing_field';
  const text = log.join('\n');

  it('keeps head, tail and the task-related middle line, and says how to get the rest', () => {
    const view = salientView(text, termsOf('fix parse_config KeyError'), 20, '/tmp/cto-ic/t1.out')!;
    expect(view).toContain(`noise line ${word(0)} nothing`);
    expect(view).toContain(`noise line ${word(399)} nothing`);
    expect(view).toContain('KeyError missing_field'); // the tiny critical clue (spec §20 case 2)
    expect(view).toContain('/tmp/cto-ic/t1.out');
    expect(view).toMatch(/omitted/);
    expect(view.length).toBeLessThan(text.length / 5);
  });

  it('declines when nothing would be saved', () => {
    expect(salientView('a\nb\nc', new Set(), 20, 'x')).toBeNull();
  });
});

describe('outlineView', () => {
  it('lists declarations with their line numbers from Read output', () => {
    const read = ['     1\timport os', '     2\t', '     3\tdef parse(x):', '     4\t    return x', '     5\tclass Loader:', '     6\t    pass'].join('\n');
    const view = outlineView(read, '/app/x.py')!;
    expect(view).toContain('3\tdef parse');
    expect(view).toContain('5\tclass Loader');
  });

  it('declines for text without declarations', () => {
    expect(outlineView('just\nprose', 'f')).toBeNull();
  });
});

describe('shapeCandidates', () => {
  it('offers only representations smaller than the original, each with a recovery footer', () => {
    const text = Array.from({ length: 300 }, (_, i) => `row ${i} value ${i * 7}`).join('\n');
    const candidates = shapeCandidates({ text, query: new Set(), locator: '/tmp/cto-ic/x.out', source: false });
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.tokens).toBeLessThan(text.length / 4);
      expect(c.text).toContain('/tmp/cto-ic/x.out');
    }
    expect(candidates.some((c) => c.representation === 'pointer')).toBe(true);
  });
});
