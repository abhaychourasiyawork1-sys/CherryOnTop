import type { JSX } from 'react';

/**
 * Infinite ticker of the product's primitives. The whole strip is decorative
 * (the same words are headings further down), so it is hidden from assistive
 * tech and holds still under reduced motion via the global motion contract.
 */
export function Marquee(props: { items: string[] }): JSX.Element {
  const track = (
    <ul className="marquee__track">
      {props.items.map((item) => (
        <li key={item} className="marquee__item">
          <span className="marquee__glyph" />
          {item}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="marquee" aria-hidden="true">
      <div className="marquee__rail">
        {track}
        {track}
      </div>
    </div>
  );
}
