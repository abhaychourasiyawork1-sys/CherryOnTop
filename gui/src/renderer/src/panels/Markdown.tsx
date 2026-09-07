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

export function Markdown({ source }: { source: string }) {
  const parts = useMemo(() => renderMarkdown(source), [source]);
  if (parts.length === 0) return null;

  return (
    <div className="md">
      {parts.map((part, index) =>
        part.kind === 'mermaid'
          ? <Diagram key={index} source={part.content} />
          // Sanitised in markdown.ts, and the page's CSP blocks scripts besides.
          : <div key={index} dangerouslySetInnerHTML={{ __html: part.content }} />,
      )}
    </div>
  );
}
