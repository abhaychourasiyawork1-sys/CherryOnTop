import { useEffect, useState, type JSX } from 'react';

const LEVELS: Array<{ level: 'story' | 'product' | 'technical'; label: string }> = [
  { level: 'story', label: 'Story' },
  { level: 'product', label: 'Product' },
  { level: 'technical', label: 'Technical' },
];

export function DepthIndicator(props: { level: 'story' | 'product' | 'technical' }): JSX.Element {
  const { level } = props;
  return (
    <div className="depth-indicator">
      {LEVELS.map((entry) => (
        <span
          key={entry.level}
          className={`depth-indicator__level${
            entry.level === level ? ' depth-indicator__level--current' : ''
          }`}
          aria-current={entry.level === level}
        >
          {entry.label}
        </span>
      ))}
    </div>
  );
}

const DEPTH_RANK: Record<'story' | 'product' | 'technical', number> = { story: 0, product: 1, technical: 2 };

function isDepthLevel(value: string | null): value is 'story' | 'product' | 'technical' {
  return value === 'story' || value === 'product' || value === 'technical';
}

/**
 * Quiet page-level marker of how deep the visitor has explored. It only ever deepens
 * (Story → Product → Technical) and is deliberately not a progress bar.
 */
export function PageDepthIndicator(): JSX.Element {
  const [level, setLevel] = useState<'story' | 'product' | 'technical'>('story');

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const depth = entry.target.getAttribute('data-depth');
          if (entry.isIntersecting && isDepthLevel(depth)) {
            setLevel((current) => (DEPTH_RANK[depth] > DEPTH_RANK[current] ? depth : current));
          }
        }
      },
      { threshold: 0.3 },
    );
    document.querySelectorAll('[data-depth]').forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);

  return (
    <aside className="page-depth" data-testid="page-depth-indicator" aria-label="Exploration depth">
      <DepthIndicator level={level} />
    </aside>
  );
}
