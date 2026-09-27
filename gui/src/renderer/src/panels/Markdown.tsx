import { useEffect, useMemo, useRef, useState } from 'react';
import { renderMarkdown } from '../lib/markdown.js';

/** Mermaid is large and most answers contain no diagram, so it is loaded the
 *  first time one actually appears rather than on every window open. */
let mermaidReady: Promise<typeof import('mermaid').default> | null = null;

function loadMermaid() {
  mermaidReady ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      // Matches the harbour palette, so a diagram belongs to the page rather
      // than arriving from a different application.
      themeVariables: {
        background: '#182230',
        primaryColor: '#1e2a3a',
        primaryTextColor: '#e4eaf0',
        primaryBorderColor: '#5fd3c4',
        lineColor: '#8fa0b4',
        secondaryColor: '#243244',
        tertiaryColor: '#131a22',
        fontFamily: 'Instrument Sans, system-ui, sans-serif',
        fontSize: '13px',
      },
    });
    return mermaid;
  });
  return mermaidReady;
}

let diagramSeq = 0;

function Diagram({ source }: { source: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadMermaid()
      .then((mermaid) => mermaid.render(`mmd-${++diagramSeq}`, source))
      .then(({ svg }) => { if (!cancelled && host.current) host.current.innerHTML = svg; })
      // A diagram the model wrote may not parse. Showing the source beats
      // showing nothing, and beats taking the answer down with it.
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [source]);

  if (failed) {
    return (
      <pre className="diagram-source">
        <code>{source}</code>
      </pre>
    );
  }
  return <div className="diagram" ref={host} />;
}

/** Copies text and says so briefly. Clipboard access can be refused; then the
 *  button says that instead of pretending. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function Markdown({ source }: { source: string }) {
  const parts = useMemo(() => renderMarkdown(source), [source]);
  const host = useRef<HTMLDivElement>(null);

  // Every code block gets a copy button, as in any chat app. Added to the
  // sanitised DOM rather than to the HTML string, so sanitising stays simple.
  useEffect(() => {
    const blocks = host.current?.querySelectorAll('pre') ?? [];
    for (const pre of Array.from(blocks)) {
      if (pre.querySelector('.code-copy') || pre.classList.contains('diagram-source')) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'code-copy';
      button.textContent = 'Copy';
      button.setAttribute('aria-label', 'Copy code');
      button.addEventListener('click', () => {
        const code = pre.querySelector('code')?.textContent ?? pre.textContent ?? '';
        void copyText(code).then((ok) => {
          button.textContent = ok ? 'Copied' : 'Copy failed';
          setTimeout(() => { button.textContent = 'Copy'; }, 1500);
        });
      });
      pre.appendChild(button);
    }
  }, [parts]);

  if (parts.length === 0) return null;

  return (
    <div className="md" ref={host}>
      {parts.map((part, index) =>
        part.kind === 'mermaid'
          ? <Diagram key={index} source={part.content} />
          // Sanitised in markdown.ts, and the page's CSP blocks scripts besides.
          : <div key={index} dangerouslySetInnerHTML={{ __html: part.content }} />,
      )}
    </div>
  );
}
