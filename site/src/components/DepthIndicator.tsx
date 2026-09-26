import type { JSX } from 'react';

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
