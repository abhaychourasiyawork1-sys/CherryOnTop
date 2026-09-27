import { useEffect, useRef, type JSX } from 'react';
import { useReducedMotion } from '../hooks/useReducedMotion';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  hot: boolean;
}

const LINK_DISTANCE = 150;

/**
 * Decorative "agent network" field behind the hero: drifting nodes that link
 * when they come close, with a few cherry-hot nodes acting as signals.
 * Purely ornamental — aria-hidden, no pointer events, one static frame under
 * reduced motion, and paused whenever it is offscreen or the tab is hidden.
 */
export function PlasmaField(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    // jsdom has no canvas backend; skip the ornament entirely there.
    if (!canvas || /jsdom/i.test(navigator.userAgent)) return undefined;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return undefined;
    const context = ctx;

    let width = 0;
    let height = 0;
    let particles: Particle[] = [];
    let frame = 0;
    let running = false;
    let onScreen = true;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas!.clientWidth;
      height = canvas!.clientHeight;
      canvas!.width = Math.round(width * dpr);
      canvas!.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(90, Math.round((width * height) / 16000));
      particles = Array.from({ length: count }, (_, i) => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        r: Math.random() * 1.4 + 0.6,
        hot: i % 11 === 0,
      }));
    }

    function draw() {
      context.clearRect(0, 0, width, height);
      for (let i = 0; i < particles.length; i += 1) {
        const a = particles[i];
        for (let j = i + 1; j < particles.length; j += 1) {
          const b = particles[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.hypot(dx, dy);
          if (dist < LINK_DISTANCE) {
            const alpha = (1 - dist / LINK_DISTANCE) * (a.hot || b.hot ? 0.34 : 0.12);
            context.strokeStyle = a.hot || b.hot ? `rgba(235, 79, 105, ${alpha})` : `rgba(245, 243, 241, ${alpha})`;
            context.lineWidth = 0.6;
            context.beginPath();
            context.moveTo(a.x, a.y);
            context.lineTo(b.x, b.y);
            context.stroke();
          }
        }
      }
      for (const p of particles) {
        if (p.hot) {
          context.fillStyle = 'rgba(235, 79, 105, 0.18)';
          context.beginPath();
          context.arc(p.x, p.y, p.r * 5, 0, Math.PI * 2);
          context.fill();
        }
        context.fillStyle = p.hot ? 'rgba(255, 120, 140, 0.95)' : 'rgba(245, 243, 241, 0.5)';
        context.beginPath();
        context.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        context.fill();
      }
    }

    function step() {
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < -20) p.x = width + 20;
        if (p.x > width + 20) p.x = -20;
        if (p.y < -20) p.y = height + 20;
        if (p.y > height + 20) p.y = -20;
      }
      draw();
      frame = window.requestAnimationFrame(step);
    }

    function start() {
      if (running || reducedMotion || !onScreen || document.visibilityState === 'hidden') return;
      running = true;
      frame = window.requestAnimationFrame(step);
    }

    function stop() {
      running = false;
      window.cancelAnimationFrame(frame);
    }

    resize();
    draw();
    start();

    function onResize() {
      resize();
      draw();
    }
    function onVisibility() {
      if (document.visibilityState === 'hidden') stop();
      else start();
    }
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);

    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver((entries) => {
        onScreen = entries.some((entry) => entry.isIntersecting);
        if (onScreen) start();
        else stop();
      });
      observer.observe(canvas);
    }

    return () => {
      stop();
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [reducedMotion]);

  return <canvas ref={canvasRef} className="plasma-field" aria-hidden="true" />;
}
