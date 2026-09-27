import { useEffect } from 'react';

const SPOTLIGHT_SELECTOR = [
  '[data-spotlight]',
  '.execution-node',
  '.mandate-panel',
  '.decision-receipt',
  '.benchmark-evidence',
  '.architecture-explorer__layer',
  '.memory-timeline',
  '.problem__question',
  '.launch-form',
].join(',');

/**
 * Pointer-follow glow for product cards. One passive document listener writes
 * `--mx` / `--my` straight onto the hovered card — no React state, no re-render.
 */
export function useSpotlight(): void {
  useEffect(() => {
    if (typeof window.matchMedia === 'function' && !window.matchMedia('(pointer: fine)').matches) {
      return undefined;
    }
    let frame = 0;
    let last: PointerEvent | null = null;

    function apply() {
      frame = 0;
      if (!last) return;
      const target = (last.target as Element | null)?.closest?.(SPOTLIGHT_SELECTOR) as HTMLElement | null;
      if (!target) return;
      const rect = target.getBoundingClientRect();
      target.style.setProperty('--mx', `${last.clientX - rect.left}px`);
      target.style.setProperty('--my', `${last.clientY - rect.top}px`);
    }

    function onMove(event: PointerEvent) {
      last = event;
      if (!frame) frame = window.requestAnimationFrame(apply);
    }

    document.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      document.removeEventListener('pointermove', onMove);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);
}
