// @vitest-environment jsdom
// DOMPurify sanitises against a real DOM. The renderer always has one;
// the default node test environment does not.
import { describe, it, expect } from 'vitest';
import { renderMarkdown, plainExcerpt } from './markdown.js';

const html = (source: string) => renderMarkdown(source).map((p) => p.content).join('');

describe('renderMarkdown', () => {
  it('renders the structure agents actually use', () => {
    expect(html('## Findings')).toContain('<h2');
    expect(html('- one\n- two')).toContain('<li>');
    expect(html('`inline`')).toContain('<code>');
    expect(html('**bold**')).toContain('<strong>');
  });

  it('renders GitHub tables, which reviews lean on', () => {
    const out = html('| File | Line |\n| --- | --- |\n| a.js | 4 |');
    expect(out).toContain('<table>');
    expect(out).toContain('<td>a.js</td>');
  });

  it('keeps fenced code as code', () => {
    const out = html('```js\nconst x = 1;\n```');
    expect(out).toContain('<pre>');
    expect(out).toContain('const x = 1;');
  });

  it('separates a mermaid diagram from the prose around it', () => {
    const parts = renderMarkdown('Before\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nAfter');
    expect(parts.map((p) => p.kind)).toEqual(['html', 'mermaid', 'html']);
    expect(parts[1].content).toBe('graph TD\n  A-->B');
    expect(parts[0].content).toContain('Before');
    expect(parts[2].content).toContain('After');
  });

  it('handles several diagrams in one answer', () => {
    const parts = renderMarkdown('```mermaid\ngraph TD\nA-->B\n```\ntext\n```mermaid\npie\n"x": 1\n```');
    expect(parts.filter((p) => p.kind === 'mermaid')).toHaveLength(2);
  });

  it('strips script and event handlers — repository content reaches this', () => {
    const out = html('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('onerror');
  });

  it('does not treat an ordinary code fence as a diagram', () => {
    const parts = renderMarkdown('```\ngraph TD\n```');
    expect(parts.every((p) => p.kind === 'html')).toBe(true);
  });

  it('returns nothing for empty input', () => {
    expect(renderMarkdown('')).toEqual([]);
    expect(renderMarkdown('   \n  ')).toEqual([]);
  });
});

describe('plainExcerpt', () => {
  it('drops heading and emphasis marks rather than showing them', () => {
    expect(plainExcerpt('## Findings\n\n**Three** bugs in `auth.js`'))
      .toBe('Findings Three bugs in auth.js');
  });

  it('does not spill a table onto the summary line', () => {
    const excerpt = plainExcerpt('Summary here.\n\n| File | Line |\n| --- | --- |\n| a.js | 4 |');
    expect(excerpt).toBe('Summary here.');
  });

  it('leaves out code blocks entirely', () => {
    expect(plainExcerpt('Fix it:\n\n```js\nconst x = 1;\n```\n\nDone.')).toBe('Fix it: Done.');
  });

  it('keeps a link’s words and drops its target', () => {
    expect(plainExcerpt('See [the docs](https://example.com/very/long) for more'))
      .toBe('See the docs for more');
  });

  it('flattens lists into a sentence', () => {
    expect(plainExcerpt('- one\n- two\n- three')).toBe('one two three');
  });

  it('clips to the limit with an ellipsis', () => {
    const excerpt = plainExcerpt('word '.repeat(100), 30);
    expect(excerpt.length).toBeLessThanOrEqual(31);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('copes with an empty answer', () => {
    expect(plainExcerpt('')).toBe('');
  });
});
