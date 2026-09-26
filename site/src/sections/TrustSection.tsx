import type { JSX } from 'react';
import { SITE_CONTENT } from '../content';

export function TrustSection(): JSX.Element {
  const { trust } = SITE_CONTENT;

  return (
    <div className="trust-section">
      <p className="trust-section__intro">{trust.headline}</p>
      <ul className="trust-section__links">
        {trust.links.map((link) => (
          <li key={link.href}>
            <a className="trust-section__link" href={link.href}>
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
