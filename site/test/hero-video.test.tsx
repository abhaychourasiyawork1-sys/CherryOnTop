import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HeroSection } from '../src/sections/HeroSection';
import { PromoVideo } from '../src/components/PromoVideo';
import { DemoControllerProvider } from '../src/demo/controller';
import { SITE_CONTENT } from '../src/content';

function renderHero() {
  return render(
    <DemoControllerProvider>
      <HeroSection />
    </DemoControllerProvider>,
  );
}

describe('HeroSection', () => {
  it('renders the exact locked hero copy', () => {
    renderHero();
    expect(screen.getByText(SITE_CONTENT.hero.eyebrow)).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: SITE_CONTENT.hero.headline }),
    ).toBeInTheDocument();
    expect(screen.getByText(SITE_CONTENT.hero.body)).toBeInTheDocument();
    expect(screen.getByText(SITE_CONTENT.hero.supportLine)).toBeInTheDocument();
  });

  it('renders both the primary and secondary CTA as distinct actions', () => {
    renderHero();
    expect(screen.getByRole('link', { name: SITE_CONTENT.hero.primaryCta })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: SITE_CONTENT.hero.secondaryCta })).toBeInTheDocument();
  });

  it('does not show benchmark statistics in the hero', () => {
    renderHero();
    expect(screen.queryByText(/SWE-bench/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/resolved/i)).not.toBeInTheDocument();
  });

  it('renders a visible live product-demo region driven by the shared demo controller', () => {
    renderHero();
    const demoRegion = screen.getByTestId('hero-demo');
    expect(demoRegion).toBeInTheDocument();
    expect(screen.getByText(/Build a customer support platform/i)).toBeInTheDocument();
  });
});

describe('PromoVideo', () => {
  it('renders a muted, inline, controlled video with a poster and accessible label', () => {
    render(
      <PromoVideo
        src="/media/cherryontop-promo.mp4"
        poster="/media/cherryontop-promo-poster.jpg"
        transcript="Transcript text."
        title="CherryOnTop product demonstration"
      />,
    );
    const video = screen.getByLabelText('CherryOnTop product demonstration') as HTMLVideoElement;
    expect(video.tagName).toBe('VIDEO');
    expect(video.muted).toBe(true);
    expect(video).toHaveAttribute('playsinline');
    expect(video).toHaveAttribute('controls');
    expect(video).toHaveAttribute('poster', '/media/cherryontop-promo-poster.jpg');
  });

  it('exposes a transcript container reachable without relying on video playback', () => {
    render(
      <PromoVideo
        src="/media/cherryontop-promo.mp4"
        poster="/media/cherryontop-promo-poster.jpg"
        transcript="Transcript text for the promo."
        title="CherryOnTop product demonstration"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /transcript/i }));
    expect(screen.getByText('Transcript text for the promo.')).toBeInTheDocument();
  });

  it('keeps the poster and a coherent watch state when the video errors', () => {
    render(
      <PromoVideo
        src="/media/cherryontop-promo.mp4"
        poster="/media/cherryontop-promo-poster.jpg"
        transcript="Transcript text."
        title="CherryOnTop product demonstration"
      />,
    );
    const video = screen.getByLabelText('CherryOnTop product demonstration');
    fireEvent.error(video);
    expect(screen.getByText(/watch the demonstration/i)).toBeInTheDocument();
    expect(video).toHaveAttribute('poster', '/media/cherryontop-promo-poster.jpg');
  });

});
