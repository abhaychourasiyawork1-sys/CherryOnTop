/** Pan-and-zoom arithmetic for the organization canvas.
 *
 *  Kept separate from the component because it is the part that is easy to get
 *  subtly wrong: zooming that is not anchored to the pointer feels like the
 *  canvas is fighting you, and the bug is invisible in a screenshot. Pure, so it
 *  can be checked directly.
 *
 *  The canvas is drawn with `transform: translate(x, y) scale(k)` and
 *  `transform-origin: 0 0`, so a canvas point c maps to the viewport at
 *  `c * k + (x, y)`. Every function here preserves that relationship. */

export interface View {
  x: number;
  y: number;
  k: number;
}

export interface Size {
  width: number;
  height: number;
}

export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 3;

export function clampZoom(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

/** The whole tree, centred, never enlarged past life size — a two-node
 *  organization should look like a two-node organization, not fill the screen. */
export function fitView(content: Size, viewport: Size, padding = 48): View {
  if (!content.width || !content.height || !viewport.width || !viewport.height) {
    return { x: 0, y: 0, k: 1 };
  }
  const k = clampZoom(Math.min(
    1,
    (viewport.width - padding * 2) / content.width,
    (viewport.height - padding * 2) / content.height,
  ));
  return {
    x: (viewport.width - content.width * k) / 2,
    y: (viewport.height - content.height * k) / 2,
    k,
  };
}

/**
 * Zoom about a fixed point in the viewport.
 *
 * The whole feel of a canvas rests on this: whatever is under the pointer stays
 * under the pointer. Zooming about the centre instead — which is what a plain
 * `transform-origin: center` does — slides the thing you were looking at off
 * the screen exactly when you lean in to read it.
 */
export function zoomAround(view: View, point: { x: number; y: number }, factor: number): View {
  const k = clampZoom(view.k * factor);
  // Already at a limit: don't pan sideways as a consolation prize.
  if (k === view.k) return view;
  // The canvas point currently under the pointer, kept under it afterwards.
  const canvasX = (point.x - view.x) / view.k;
  const canvasY = (point.y - view.y) / view.k;
  return { x: point.x - canvasX * k, y: point.y - canvasY * k, k };
}

/** Zoom about the middle of the viewport — what the +/− buttons and the
 *  keyboard do, since neither has a pointer position to work from. */
export function zoomCentre(view: View, viewport: Size, factor: number): View {
  return zoomAround(view, { x: viewport.width / 2, y: viewport.height / 2 }, factor);
}

export function pan(view: View, dx: number, dy: number): View {
  return { ...view, x: view.x + dx, y: view.y + dy };
}

/** Where a canvas point currently sits in the viewport. Used to bring a
 *  selected node into view without changing the zoom. */
export function toViewport(view: View, point: { x: number; y: number }): { x: number; y: number } {
  return { x: point.x * view.k + view.x, y: point.y * view.k + view.y };
}

/** Pans just enough to bring a canvas rectangle fully into view, and not at all
 *  if it is already there.
 *
 *  The canvas is `overflow: hidden`, so the browser can no longer scroll a
 *  keyboard-focused card into view the way it would in a scrolling container.
 *  Without this, tabbing through a large organization moves focus to cards
 *  nobody can see. Zoom is deliberately left alone: moving the view is helpful,
 *  resizing it under someone is disorienting. */
export function panIntoView(
  view: View,
  rect: { x: number; y: number; width: number; height: number },
  viewport: Size,
  margin = 24,
): View {
  const left = rect.x * view.k + view.x;
  const top = rect.y * view.k + view.y;
  const right = left + rect.width * view.k;
  const bottom = top + rect.height * view.k;

  let dx = 0;
  let dy = 0;
  if (left < margin) dx = margin - left;
  else if (right > viewport.width - margin) dx = Math.max(viewport.width - margin - right, margin - left);
  if (top < margin) dy = margin - top;
  else if (bottom > viewport.height - margin) dy = Math.max(viewport.height - margin - bottom, margin - top);

  return dx === 0 && dy === 0 ? view : pan(view, dx, dy);
}

/** A wheel notch to a zoom factor.
 *
 *  Trackpads report many small deltas and a mouse wheel reports few large ones,
 *  so a factor proportional to the raw delta makes one device crawl and the
 *  other leap. Damping the exponent evens them out. deltaMode 1 is lines rather
 *  than pixels, which Firefox reports for a real wheel.
 */
export function wheelFactor(deltaY: number, deltaMode = 0): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaY;
  return Math.exp(-Math.max(-120, Math.min(120, pixels)) * 0.002);
}
