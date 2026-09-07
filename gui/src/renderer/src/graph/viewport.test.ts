import { describe, it, expect } from 'vitest';
import {
  fitView, zoomAround, zoomCentre, pan, toViewport, wheelFactor, clampZoom,
  panIntoView, MIN_ZOOM, MAX_ZOOM,
} from './viewport.js';

const VIEWPORT = { width: 1000, height: 600 };

describe('fitting the organization', () => {
  it('centres the tree in the viewport', () => {
    const view = fitView({ width: 800, height: 400 }, VIEWPORT, 0);
    expect(view.k).toBe(1);
    expect(view.x).toBe(100);
    expect(view.y).toBe(100);
  });

  it('shrinks a tree that does not fit, and still centres it', () => {
    const view = fitView({ width: 4000, height: 400 }, VIEWPORT, 0);
    expect(view.k).toBeCloseTo(0.25);
    expect(view.x).toBeCloseTo(0);
    expect(toViewport(view, { x: 2000, y: 0 }).x).toBeCloseTo(VIEWPORT.width / 2);
  });

  it('never enlarges past life size', () => {
    expect(fitView({ width: 50, height: 50 }, VIEWPORT, 0).k).toBe(1);
  });

  it('survives a viewport that has not been measured yet', () => {
    expect(fitView({ width: 0, height: 0 }, VIEWPORT)).toEqual({ x: 0, y: 0, k: 1 });
    expect(fitView({ width: 800, height: 400 }, { width: 0, height: 0 })).toEqual({ x: 0, y: 0, k: 1 });
  });
});

describe('zooming about the pointer', () => {
  it('keeps whatever is under the pointer under the pointer', () => {
    // The property the whole feel of the canvas rests on.
    const view = { x: 0, y: 0, k: 1 };
    const pointer = { x: 300, y: 200 };
    const before = { x: (pointer.x - view.x) / view.k, y: (pointer.y - view.y) / view.k };

    const zoomed = zoomAround(view, pointer, 2);
    const after = toViewport(zoomed, before);

    expect(after.x).toBeCloseTo(pointer.x);
    expect(after.y).toBeCloseTo(pointer.y);
  });

  it('holds that property when already panned and scaled', () => {
    const view = { x: -420, y: 137, k: 0.63 };
    const pointer = { x: 812, y: 44 };
    const canvasPoint = { x: (pointer.x - view.x) / view.k, y: (pointer.y - view.y) / view.k };

    for (const factor of [1.2, 0.5, 3, 0.1]) {
      const after = toViewport(zoomAround(view, pointer, factor), canvasPoint);
      expect(after.x).toBeCloseTo(pointer.x);
      expect(after.y).toBeCloseTo(pointer.y);
    }
  });

  it('refuses to drift sideways once it is against a zoom limit', () => {
    const atMax = { x: 40, y: 40, k: MAX_ZOOM };
    expect(zoomAround(atMax, { x: 500, y: 300 }, 2)).toEqual(atMax);

    const atMin = { x: 40, y: 40, k: MIN_ZOOM };
    expect(zoomAround(atMin, { x: 500, y: 300 }, 0.5)).toEqual(atMin);
  });

  it('clamps within range rather than refusing the whole gesture', () => {
    expect(zoomAround({ x: 0, y: 0, k: 2 }, { x: 0, y: 0 }, 10).k).toBe(MAX_ZOOM);
    expect(clampZoom(999)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
  });

  it('zooms about the middle when there is no pointer to work from', () => {
    const zoomed = zoomCentre({ x: 0, y: 0, k: 1 }, VIEWPORT, 2);
    // The canvas point at the viewport centre stays at the viewport centre.
    expect(toViewport(zoomed, { x: 500, y: 300 })).toEqual({ x: 500, y: 300 });
  });
});

describe('panning', () => {
  it('moves the canvas with the pointer, one pixel per pixel', () => {
    expect(pan({ x: 10, y: 20, k: 0.5 }, 30, -5)).toEqual({ x: 40, y: 15, k: 0.5 });
  });

  it('does not change the zoom', () => {
    expect(pan({ x: 0, y: 0, k: 0.37 }, 100, 100).k).toBe(0.37);
  });
});

describe('the wheel', () => {
  it('zooms in when the wheel goes up, out when it goes down', () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
  });

  it('is symmetric, so a notch back undoes a notch forward', () => {
    expect(wheelFactor(-50) * wheelFactor(50)).toBeCloseTo(1);
  });

  it('keeps one enormous delta from swallowing the whole range', () => {
    // Some mice report 400+ per notch; unclamped that is a jump to the limit.
    expect(wheelFactor(4000)).toBeCloseTo(wheelFactor(120));
    expect(wheelFactor(-4000)).toBeCloseTo(wheelFactor(-120));
  });

  it('treats a line-mode wheel as a comparable distance to a pixel-mode one', () => {
    // Firefox reports deltaMode 1 (lines) for a real wheel; untranslated, a
    // delta of 3 would be a rounding error instead of a notch.
    expect(wheelFactor(3, 1)).toBeLessThan(wheelFactor(3, 0));
  });
});

describe('bringing a focused card into view', () => {
  const view = { x: 0, y: 0, k: 1 };
  const card = { width: 208, height: 86 };

  it('leaves a card that is already visible exactly where it is', () => {
    expect(panIntoView(view, { x: 300, y: 200, ...card }, VIEWPORT)).toBe(view);
  });

  it('pans right to reach a card off the left edge', () => {
    const moved = panIntoView(view, { x: -100, y: 200, ...card }, VIEWPORT);
    expect(moved.x).toBe(124);
    expect(moved.k).toBe(view.k);
  });

  it('pans left to reach a card off the right edge', () => {
    const moved = panIntoView(view, { x: 900, y: 200, ...card }, VIEWPORT);
    expect(moved.x + 900 + card.width).toBeLessThanOrEqual(VIEWPORT.width);
  });

  it('pans down to reach a card above the top', () => {
    expect(panIntoView(view, { x: 300, y: -60, ...card }, VIEWPORT).y).toBe(84);
  });

  it('prefers the card`s top-left when it is larger than the viewport', () => {
    // Otherwise a card taller than the screen scrolls to its bottom edge and
    // the label — which is at the top — is the part left off.
    const huge = { x: 0, y: 0, width: 2000, height: 2000 };
    const moved = panIntoView(view, huge, VIEWPORT);
    expect(moved.x).toBe(24);
    expect(moved.y).toBe(24);
  });

  it('accounts for the zoom, since a card is smaller when zoomed out', () => {
    const zoomedOut = { x: 0, y: 0, k: 0.5 };
    // At half scale this card ends at x=554, comfortably inside 1000.
    expect(panIntoView(zoomedOut, { x: 900, y: 200, ...card }, VIEWPORT)).toBe(zoomedOut);
  });

  it('never changes the zoom', () => {
    const moved = panIntoView({ x: 0, y: 0, k: 0.37 }, { x: -500, y: -500, ...card }, VIEWPORT);
    expect(moved.k).toBe(0.37);
  });
});
