import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import App from '../src/App';
import { Reveal } from '../src/components/Reveal';
import { PromoVideo } from '../src/components/PromoVideo';
import { StatusIndicator } from '../src/components/StatusIndicator';
import { DemoControllerProvider, useDemoController } from '../src/demo/controller';
import { useReducedMotion } from '../src/hooks/useReducedMotion';
import type { Status } from '../src/types';

function readStyle(name: string): string {
  return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/styles', name), 'utf8');
}

/** Minimal accessible-name resolution: aria-labelledby, aria-label, <label>, text, alt, title. */
function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    return labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
  }
  const ariaLabel = element.getAttribute('aria-label')?.trim();
  if (ariaLabel) return ariaLabel;
  if (element.id) {
    const label = document.querySelector(`label[for="${element.id}"]`)?.textContent?.trim();
    if (label) return label;
  }
  const wrappingLabel = element.closest('label')?.textContent?.trim();
  if (wrappingLabel) return wrappingLabel;
  const text = element.textContent?.trim();
  if (text) return text;
  const alt = [...element.querySelectorAll('img[alt]')].map((img) => img.getAttribute('alt')).join(' ').trim();
  if (alt) return alt;
  return element.getAttribute('title')?.trim() ?? '';
}

type Listener = () => void;

/** matchMedia stub whose reduced-motion answer can be flipped, with listener bookkeeping. */
function stubMatchMedia(initial: boolean) {
  const listeners = new Set<Listener>();
  const state = { reduce: initial };
  const mql = {
    get matches() {
      return state.reduce;
    },
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: (_: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
    addListener: (fn: Listener) => listeners.add(fn),
    removeListener: (fn: Listener) => listeners.delete(fn),
    dispatchEvent: () => true,
  };
  vi.stubGlobal('matchMedia', (query: string) =>
    query.includes('prefers-reduced-motion') ? mql : { ...mql, matches: false, media: query },
  );
  return {
    listeners,
    set(reduce: boolean) {
      state.reduce = reduce;
      for (const fn of [...listeners]) fn();
    },
  };
}

/** IntersectionObserver that never reports an intersection. */
class SilentIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('page accessibility structure', () => {
  it('has exactly one h1', () => {
    render(<App />);
    expect(document.querySelectorAll('h1')).toHaveLength(1);
  });

  it('never skips a heading level when going deeper', () => {
    render(<App />);
    const levels = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => Number(h.tagName[1]));
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1);
    }
  });

  it('gives every interactive element an accessible name', () => {
    render(<App />);
    const interactive = document.querySelectorAll('a[href], button, input, select, textarea, video, [tabindex]');
    expect(interactive.length).toBeGreaterThan(10);
    for (const element of interactive) {
      if ((element as HTMLInputElement).type === 'hidden') continue;
      const name = accessibleName(element);
      expect(name, element.outerHTML.slice(0, 120)).not.toBe('');
    }
  });

  it('defines a visible focus style', () => {
    const globals = readStyle('globals.css');
    expect(globals).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid/);
  });

  it('conveys every status with a text label and a shape, not colour alone', () => {
    const statuses: Status[] = ['idle', 'working', 'waiting', 'attention', 'recovering', 'validating', 'verified'];
    for (const status of statuses) {
      const { container, unmount } = render(<StatusIndicator status={status} />);
      const label = container.querySelector('.status-indicator__label')?.textContent ?? '';
      const icon = container.querySelector('[data-testid="status-icon"]')?.textContent ?? '';
      expect(label.trim().length).toBeGreaterThan(0);
      expect(icon.trim().length).toBeGreaterThan(0);
      unmount();
    }
  });

  it('labels the promo video and offers a transcript path', () => {
    render(<App />);
    expect(screen.getByLabelText('CherryOnTop product demonstration').tagName).toBe('VIDEO');
    expect(screen.getByRole('button', { name: /show transcript/i })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('link', { name: /open full transcript/i })).toHaveAttribute(
      'href',
      '/media/cherryontop-promo-transcript.txt',
    );
  });

  it('makes navigation keyboard operable with exposed expanded state', () => {
    render(<App />);
    const trigger = screen.getByRole('button', { name: 'Menu' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    trigger.focus();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('dialog', { name: 'Mobile navigation' });
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('exposes aria-expanded on every disclosure control, using native buttons', () => {
    render(<App />);
    const disclosures = document.querySelectorAll('[aria-expanded]');
    expect(disclosures.length).toBeGreaterThanOrEqual(3);
    for (const control of disclosures) {
      expect(control.tagName).toBe('BUTTON');
      expect(control).toHaveAttribute('type', 'button');
    }
  });
});

describe('media fallback', () => {
  it('exposes the poster and the transcript when the video fails', () => {
    render(
      <PromoVideo
        src="/media/missing.mp4"
        poster="/media/cherryontop-promo-poster.jpg"
        transcript="Transcript text for the promo."
        title="CherryOnTop product demonstration"
      />,
    );
    fireEvent.error(screen.getByLabelText('CherryOnTop product demonstration'));
    expect(screen.getByRole('img', { name: /poster/i })).toHaveAttribute('src', '/media/cherryontop-promo-poster.jpg');
    expect(screen.getByTestId('promo-video-transcript')).toHaveTextContent('Transcript text for the promo.');
  });
});

describe('reduced motion', () => {
  let media: ReturnType<typeof stubMatchMedia>;

  beforeEach(() => {
    media = stubMatchMedia(true);
  });

  it('reveals content immediately without waiting for IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', SilentIntersectionObserver);
    const { container } = render(
      <Reveal>
        <p>Visible content</p>
      </Reveal>,
    );
    expect(container.querySelector('.reveal')).toHaveClass('reveal--visible');
  });

  it('advances the demo through every state without animation pauses', () => {
    vi.useFakeTimers();
    function Probe() {
      const { snapshot, reducedMotion } = useDemoController();
      return (
        <p data-testid="probe" data-reduced={String(reducedMotion)}>
          {snapshot.state}
        </p>
      );
    }
    render(
      <DemoControllerProvider>
        <Probe />
      </DemoControllerProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveAttribute('data-reduced', 'true');
    // Every state takes a 0ms step; well under any single animated beat (>=1200ms).
    for (let i = 0; i < 12; i += 1) {
      act(() => {
        vi.advanceTimersByTime(1);
      });
    }
    expect(screen.getByTestId('probe')).toHaveTextContent('memory');
  });

  it('does not autoplay the promo video', () => {
    render(
      <PromoVideo src="/v.mp4" poster="/p.jpg" transcript="t" title="CherryOnTop product demonstration" />,
    );
    expect(screen.getByLabelText('CherryOnTop product demonstration')).not.toHaveAttribute('autoplay');
  });

  it('disables ornamental transitions and animations globally in CSS', () => {
    const motion = readStyle('motion.css');
    expect(motion).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*,[\s\S]*?animation-duration: 0\.01ms !important;[\s\S]*?transition-duration: 0\.01ms !important;/,
    );
  });

  it('useReducedMotion follows preference changes and unsubscribes on unmount', () => {
    const { result, unmount } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);
    expect(media.listeners.size).toBeGreaterThan(0);
    act(() => media.set(false));
    expect(result.current).toBe(false);
    unmount();
    expect(media.listeners.size).toBe(0);
  });
});
