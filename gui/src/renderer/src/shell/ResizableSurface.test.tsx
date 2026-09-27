// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { ResizableSurface } from './ResizableSurface.js';
import { render, key } from '../testing/render.js';
import { MIN_WIDTH, MAX_WIDTH, type Surface } from '../lib/surfaces.js';

const surface: Surface = { id: 'plan:x', kind: 'plan', contextId: 'x', persistence: 'transient', width: 400, collapsed: false };

describe('resizable surface', () => {
  it('resizes from the keyboard on its focusable edge', () => {
    const onResize = vi.fn();
    const view = render(
      <ResizableSurface surface={surface} title="Plan" onClose={() => {}} onPin={() => {}} onCollapse={() => {}} onResize={onResize}>
        body
      </ResizableSurface>,
    );
    const edge = view.container.querySelector('[role="separator"]')!;
    expect(edge.getAttribute('tabindex')).toBe('0');
    expect(edge.getAttribute('aria-valuenow')).toBe('400');
    key(edge, 'ArrowLeft');
    key(edge, 'ArrowRight', { shiftKey: true });
    key(edge, 'Home');
    key(edge, 'End');
    expect(onResize.mock.calls.map((c) => c[0])).toEqual([424, 304, MAX_WIDTH, MIN_WIDTH]);
    view.unmount();
  });

  it('names every control for assistive technology and reflects pinning', () => {
    const onPin = vi.fn();
    const view = render(
      <ResizableSurface surface={{ ...surface, persistence: 'pinned' }} title="Plan" onClose={() => {}} onPin={onPin} onCollapse={() => {}} onResize={() => {}}>
        body
      </ResizableSurface>,
    );
    const buttons = [...view.container.querySelectorAll('button')];
    expect(buttons.every((b) => b.getAttribute('aria-label'))).toBe(true);
    const pin = buttons.find((b) => b.getAttribute('aria-pressed') !== null)!;
    expect(pin.getAttribute('aria-pressed')).toBe('true');
    pin.click();
    expect(onPin).toHaveBeenCalledWith(false);
    view.unmount();
  });
});
