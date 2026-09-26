import type { JSX } from 'react';
import { SITE_CONTENT } from '../content';

export function SiteFooter(): JSX.Element {
  const { footer } = SITE_CONTENT;

  return (
    <footer className="site-footer">
      <div className="container site-footer__groups">
        {footer.groups.map((group) => (
          <div key={group.title} className="site-footer__group">
            <p className="site-footer__group-title">{group.title}</p>
            <ul className="site-footer__links">
              {group.links.map((link) => (
                <li key={link.href}>
                  <a className="site-footer__link" href={link.href}>
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="container site-footer__brand-row">
        <span className="site-footer__brand">CherryOnTop</span>
      </div>
    </footer>
  );
}
