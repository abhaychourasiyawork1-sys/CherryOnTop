import '@testing-library/jest-dom/vitest';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SiteHeader } from '../src/components/SiteHeader';
import { SiteFooter } from '../src/components/SiteFooter';
import { BenchmarkEvidence } from '../src/components/BenchmarkEvidence';
import { ArchitectureExplorer } from '../src/components/ArchitectureExplorer';
import { TrustSection } from '../src/sections/TrustSection';
import { LaunchForm } from '../src/components/LaunchForm';
import App from '../src/App';
import { SITE_CONTENT } from '../src/content';

describe('SiteHeader navigation', () => {
  it('shows every approved nav label exactly once, including the CTA', () => {
    render(<SiteHeader />);
    for (const link of SITE_CONTENT.nav.links) {
      expect(screen.getByRole('link', { name: link.label })).toBeInTheDocument();
    }
    expect(screen.getAllByText(SITE_CONTENT.nav.cta).length).toBeGreaterThan(0);
  });

  it('links every nav anchor to a section id that exists in the page', () => {
    render(<App />);
    for (const link of SITE_CONTENT.nav.links) {
      if (link.href.startsWith('#')) {
        expect(document.querySelector(link.href)).not.toBeNull();
      }
    }
  });

  it('makes the final launch CTA reachable from the header and from the hero', () => {
    render(<App />);
    expect(document.querySelector('#launch')).not.toBeNull();

    const ctasToLaunch = screen
      .getAllByRole('link', { name: SITE_CONTENT.nav.cta })
      .filter((el) => el.getAttribute('href') === '#launch');
    expect(ctasToLaunch.length).toBeGreaterThanOrEqual(2);

    const heroCta = document.querySelector('.hero__cta--primary');
    expect(heroCta).toHaveAttribute('href', '#launch');
  });

  it('gains a scrolled surface after the page scrolls down', () => {
    render(<SiteHeader />);
    const header = screen.getByRole('banner');
    expect(header).not.toHaveClass('site-header--scrolled');
    Object.defineProperty(window, 'scrollY', { value: 40, configurable: true });
    fireEvent.scroll(window);
    expect(header).toHaveClass('site-header--scrolled');
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    fireEvent.scroll(window);
  });

  describe('mobile menu', () => {
    afterEach(() => {
      document.body.innerHTML = '';
    });

    it('traps focus while open and returns focus to the trigger on close', () => {
      render(<SiteHeader />);
      const trigger = screen.getByRole('button', { name: /menu/i });
      fireEvent.click(trigger);

      const dialog = screen.getByRole('dialog', { name: /mobile navigation/i });
      const focusable = within(dialog).getAllByRole('link');
      expect(focusable.length).toBeGreaterThan(0);

      focusable[focusable.length - 1].focus();
      fireEvent.keyDown(dialog, { key: 'Tab' });
      expect(document.activeElement).toBe(focusable[0]);

      fireEvent.keyDown(dialog, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(document.activeElement).toBe(trigger);
    });

    it('closes the menu when a link is selected', () => {
      render(<SiteHeader />);
      fireEvent.click(screen.getByRole('button', { name: /menu/i }));
      const dialog = screen.getByRole('dialog', { name: /mobile navigation/i });
      fireEvent.click(within(dialog).getAllByRole('link')[0]);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});

describe('SiteFooter', () => {
  it('contains product, resources, company, and legal groups without link sprawl', () => {
    render(<SiteFooter />);
    const groupTitles = SITE_CONTENT.footer.groups.map((group) => group.title);
    expect(groupTitles).toEqual(['Product', 'Resources', 'Company', 'Legal']);
    for (const group of SITE_CONTENT.footer.groups) {
      expect(screen.getAllByText(group.title).length).toBeGreaterThan(0);
      for (const link of group.links) {
        expect(screen.getByRole('link', { name: link.label })).toBeInTheDocument();
      }
    }
    const totalLinks = SITE_CONTENT.footer.groups.reduce((sum, g) => sum + g.links.length, 0);
    expect(totalLinks).toBeLessThanOrEqual(12);
  });
});

describe('BenchmarkEvidence', () => {
  it('shows the measured, scope-qualified benchmark evidence', () => {
    render(<BenchmarkEvidence />);
    expect(screen.getByText(SITE_CONTENT.benchmarks.resolved)).toBeInTheDocument();
    expect(screen.getByText(SITE_CONTENT.benchmarks.costDelta)).toBeInTheDocument();
    expect(screen.getByText(SITE_CONTENT.benchmarks.tokenDelta)).toBeInTheDocument();
    expect(screen.getByText(SITE_CONTENT.benchmarks.methodology)).toBeInTheDocument();
    expect(screen.getByText(SITE_CONTENT.benchmarks.limitations)).toBeInTheDocument();
  });

  it('links to the auditable benchmark methodology document', () => {
    render(<BenchmarkEvidence />);
    const link = screen.getByRole('link', { name: /methodology|benchmarks\.md|full methodology/i });
    expect(link).toHaveAttribute('href', SITE_CONTENT.benchmarks.methodologyLink);
  });
});

describe('ArchitectureExplorer', () => {
  it('shows the default layer sequence collapsed', () => {
    render(<ArchitectureExplorer layers={SITE_CONTENT.architecture.layers.map(toLayer)} />);
    for (const layer of SITE_CONTENT.architecture.layers) {
      expect(screen.getByText(layer.title)).toBeInTheDocument();
    }
    expect(screen.queryByText('Context')).not.toBeInTheDocument();
    expect(screen.queryByText('Evidence')).not.toBeInTheDocument();
  });

  it('reveals Context, Decision, Policy, State, Budget when CONTROL PLANE is opened', () => {
    render(<ArchitectureExplorer layers={SITE_CONTENT.architecture.layers.map(toLayer)} />);
    fireEvent.click(screen.getByRole('button', { name: /control plane/i }));
    for (const child of ['Context', 'Decision', 'Policy', 'State', 'Budget']) {
      expect(screen.getByText(child)).toBeInTheDocument();
    }
  });

  it('reveals Evidence, Artifacts, Validation, Decision Receipt when PROOF is opened', () => {
    render(<ArchitectureExplorer layers={SITE_CONTENT.architecture.layers.map(toLayer)} />);
    fireEvent.click(screen.getByRole('button', { name: /^proof/i }));
    for (const child of ['Evidence', 'Artifacts', 'Validation', 'Decision Receipt']) {
      expect(screen.getByText(child)).toBeInTheDocument();
    }
  });
});

function toLayer(layer: (typeof SITE_CONTENT.architecture.layers)[number]) {
  return { id: layer.title.toLowerCase().replace(/\s+/g, '-'), ...layer };
}

describe('TrustSection', () => {
  it('shows real evidence links without fake social proof', () => {
    render(<TrustSection />);
    expect(screen.getByText(SITE_CONTENT.trust.headline)).toBeInTheDocument();
    for (const link of SITE_CONTENT.trust.links) {
      expect(screen.getByRole('link', { name: link.label })).toBeInTheDocument();
    }
    expect(screen.queryByText(/testimonial/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/customers love/i)).not.toBeInTheDocument();
  });
});

describe('LaunchForm', () => {
  it('rejects an invalid email without calling onSuccess', () => {
    const onSuccess = () => {
      throw new Error('should not succeed with an invalid email');
    };
    render(<LaunchForm onSuccess={onSuccess} />);
    fireEvent.change(screen.getByLabelText(SITE_CONTENT.launch.emailLabel), {
      target: { value: 'not-an-email' },
    });
    fireEvent.click(screen.getByRole('button', { name: SITE_CONTENT.launch.submitLabel }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('shows the success copy after a valid submission against the waitlist API', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    let succeeded = false;
    render(<LaunchForm onSuccess={() => { succeeded = true; }} />);
    fireEvent.change(screen.getByLabelText(SITE_CONTENT.launch.emailLabel), {
      target: { value: 'person@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: SITE_CONTENT.launch.submitLabel }));

    expect(await screen.findByText(SITE_CONTENT.launch.successHeadline)).toBeInTheDocument();
    expect(screen.getByText(SITE_CONTENT.launch.successBody)).toBeInTheDocument();
    expect(succeeded).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('/api/waitlist', expect.objectContaining({ method: 'POST' }));
    vi.unstubAllGlobals();
  });

  it('does not hardcode pricing anywhere in the launch copy', () => {
    render(<LaunchForm />);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\$\d/);
  });
});

describe('Full page anchors', () => {
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('renders one section per nav/footer destination anchor', () => {
    render(<App />);
    for (const id of ['product', 'how-it-works', 'architecture', 'benchmarks', 'trust', 'launch']) {
      expect(document.getElementById(id)).not.toBeNull();
    }
  });
});
