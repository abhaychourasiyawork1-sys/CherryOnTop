import { marked } from 'marked';
import DOMPurify from 'dompurify';

/** Agent output is Markdown — tables, code, headings, and sometimes a mermaid
 *  diagram. Rendering it as preformatted text threw all of that away.
 *
 *  It is still untrusted: it comes from a model that read the repository, and a
 *  repository can contain anything. So it is parsed, then sanitised, and the
 *  page's CSP blocks scripts regardless. */

marked.setOptions({ gfm: true, breaks: true });

/** Mermaid blocks are pulled out before sanitising and rendered separately —
 *  they are diagram source, not HTML, and must not be mangled into a code block
 *  or stripped. */
export interface MarkdownPart {
  kind: 'html' | 'mermaid';
  content: string;
}

const MERMAID_FENCE = /^```mermaid[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/gm;

export function renderMarkdown(source: string): MarkdownPart[] {
  if (!source.trim()) return [];

  const parts: MarkdownPart[] = [];
  let lastIndex = 0;

  MERMAID_FENCE.lastIndex = 0;
  for (const match of source.matchAll(MERMAID_FENCE)) {
    const before = source.slice(lastIndex, match.index);
    if (before.trim()) parts.push({ kind: 'html', content: toSafeHtml(before) });
    if (match[1].trim()) parts.push({ kind: 'mermaid', content: match[1].trim() });
    lastIndex = (match.index ?? 0) + match[0].length;
  }

  const rest = source.slice(lastIndex);
  if (rest.trim()) parts.push({ kind: 'html', content: toSafeHtml(rest) });

  return parts;
}

function toSafeHtml(markdown: string): string {
  const html = marked.parse(markdown, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    // Links are shown but never navigable from inside the app; a click would
    // replace the window with whatever the model wrote.
    FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form', 'input', 'script'],
    FORBID_ATTR: ['style', 'srcset', 'formaction', 'ping'],
  });
}

/** A one-line, syntax-free glimpse of a Markdown answer, for places that show a
 *  child in outline. Flattening the raw source instead would put "## Findings |
 *  File | Line | --- |" on screen, which reads as damage rather than as a
 *  summary. */
export function plainExcerpt(markdown: string, limit = 220): string {
  const plain = markdown
    // Fenced code and diagrams: the fact there is code is not the summary.
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')           // heading markers
    .replace(/^\s{0,3}[-*+]\s+/gm, '')            // bullets
    .replace(/^\s{0,3}\d+\.\s+/gm, '')           // numbered items
    .replace(/^\s{0,3}>\s?/gm, '')                // quotes
    .replace(/^\s*\|.*\|\s*$/gm, ' ')            // table rows, header rules included
    .replace(/^\s*[-:|\s]{3,}\s*$/gm, ' ')        // setext and table separators
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')   // links and images keep their text
    .replace(/[*_~`]/g, '')                       // emphasis and inline code marks
    .replace(/\s+/g, ' ')
    .trim();

  return plain.length <= limit ? plain : `${plain.slice(0, limit).trimEnd()}…`;
}
