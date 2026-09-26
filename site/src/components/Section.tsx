import type { JSX } from 'react';

export type DepthLevel = 'story' | 'product' | 'technical';
export type SectionRhythm = 'sparse' | 'dense' | 'focused' | 'active' | 'still' | 'clean' | 'rich' | 'quiet' | 'analytical' | 'technical';

export function Section(props: {
  id: string;
  eyebrow?: string;
  title: string;
  body?: string;
  depth?: DepthLevel;
  rhythm?: SectionRhythm;
  children: React.ReactNode;
}): JSX.Element {
  const { id, eyebrow, title, body, depth, rhythm, children } = props;
  return (
    <section
      id={id}
      className="site-section"
      aria-labelledby={`${id}-title`}
      data-depth={depth}
      data-rhythm={rhythm}
    >
      <div className="container">
        <div className="site-section__intro">
          {eyebrow ? <p className="site-section__eyebrow">{eyebrow}</p> : null}
          <h2 id={`${id}-title`} className="site-section__title">
            {title}
          </h2>
          {body ? <p className="site-section__body">{body}</p> : null}
        </div>
        {children}
      </div>
    </section>
  );
}
