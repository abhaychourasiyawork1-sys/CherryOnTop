import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PromoVideo } from '../src/components/PromoVideo';

type ObserverCallback = (entries: Array<{ isIntersecting: boolean }>) => void;

function installIntersectionObserver() {
  const instances: Array<{ callback: ObserverCallback; disconnect: ReturnType<typeof vi.fn> }> = [];
  class MockIntersectionObserver {
    disconnect = vi.fn();
    constructor(public callback: ObserverCallback) {
      instances.push(this);
    }
    observe() {}
    unobserve() {}
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  return instances;
}

function renderVideo() {
  return render(
    <PromoVideo
      src="/media/cherryontop-promo.mp4"
      poster="/media/cherryontop-promo-poster.jpg"
      transcript="Transcript."
      title="CherryOnTop product demonstration"
    />,
  );
}

describe('performance contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not fetch the video before it is near the viewport', () => {
    const observers = installIntersectionObserver();
    renderVideo();
    const video = screen.getByLabelText('CherryOnTop product demonstration') as HTMLVideoElement;
    expect(video).not.toHaveAttribute('src');
    expect(video).toHaveAttribute('preload', 'none');
    expect(video).toHaveAttribute('poster', '/media/cherryontop-promo-poster.jpg');

    act(() => observers[0]?.callback([{ isIntersecting: true }]));
    expect(video).toHaveAttribute('src', '/media/cherryontop-promo.mp4');
  });

  it('pauses the looping video when it leaves the viewport and resumes when it returns', () => {
    const observers = installIntersectionObserver();
    renderVideo();
    const video = screen.getByLabelText('CherryOnTop product demonstration') as HTMLVideoElement;
    act(() => observers[0]?.callback([{ isIntersecting: true }]));

    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    const pause = vi.spyOn(video, 'pause').mockImplementation(() => undefined);
    const play = vi.spyOn(video, 'play').mockImplementation(() => Promise.resolve());

    act(() => observers[0]?.callback([{ isIntersecting: false }]));
    expect(pause).toHaveBeenCalledTimes(1);
    act(() => observers[0]?.callback([{ isIntersecting: true }]));
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('disconnects its observer on unmount', () => {
    const observers = installIntersectionObserver();
    const { unmount } = renderVideo();
    unmount();
    expect(observers[0]?.disconnect).toHaveBeenCalled();
  });

  it('does not autoplay when reduced motion is requested', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    renderVideo();
    const video = screen.getByLabelText('CherryOnTop product demonstration') as HTMLVideoElement;
    expect(video.autoplay).toBe(false);
  });

  it('keeps semantic hero content in HTML independent of media', () => {
    const html = readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');
    expect(html).not.toMatch(/\.mp4|<video/);
    expect(html).toMatch(/<title>CherryOnTop — AI teams you can hold accountable\.<\/title>/);
  });
});
