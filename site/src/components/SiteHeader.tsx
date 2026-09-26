import { useEffect, useRef, useState, type JSX } from 'react';
import { SITE_CONTENT } from '../content';

export function SiteHeader(): JSX.Element {
  const { nav } = SITE_CONTENT;
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onScroll() {
      setScrolled(window.scrollY > 8);
    }
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!menuOpen) {
      return undefined;
    }
    const menu = menuRef.current;
    if (!menu) {
      return undefined;
    }

    const focusable = Array.from(menu.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
    focusable[0]?.focus();

    function closeAndReturnFocus() {
      setMenuOpen(false);
      triggerRef.current?.focus();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        closeAndReturnFocus();
        return;
      }
      if (event.key !== 'Tab' || focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    menu.addEventListener('keydown', onKeyDown);
    return () => menu.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);

  function closeMenu() {
    setMenuOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <header className={`site-header${scrolled ? ' site-header--scrolled' : ''}`}>
      <div className="container site-header__row">
        <a className="site-header__brand" href="#product">
          CherryOnTop
        </a>

        <nav className="site-header__nav" aria-label="Primary">
          {nav.links.map((link) => (
            <a key={link.href} className="site-header__link" href={link.href}>
              {link.label}
            </a>
          ))}
        </nav>

        <a className="site-header__cta" href="#launch">
          {nav.cta}
        </a>

        <button
          type="button"
          ref={triggerRef}
          className="site-header__menu-trigger"
          aria-expanded={menuOpen}
          aria-controls="site-header-mobile-menu"
          onClick={() => setMenuOpen((value) => !value)}
        >
          Menu
        </button>
      </div>

      {menuOpen ? (
        <div
          id="site-header-mobile-menu"
          ref={menuRef}
          className="site-header__mobile-menu"
          role="dialog"
          aria-modal="true"
          aria-label="Mobile navigation"
        >
          {nav.links.map((link) => (
            <a
              key={link.href}
              className="site-header__mobile-link"
              href={link.href}
              onClick={closeMenu}
            >
              {link.label}
            </a>
          ))}
          <a className="site-header__mobile-cta" href="#launch" onClick={closeMenu}>
            {nav.cta}
          </a>
        </div>
      ) : null}
    </header>
  );
}
