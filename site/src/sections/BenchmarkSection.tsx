import { useEffect, useRef, type JSX } from 'react';
import { BenchmarkEvidence } from '../components/BenchmarkEvidence';
import { track } from '../analytics/tracker';

export function BenchmarkSection(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          track('benchmark_viewed');
          observer.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="benchmark-section" ref={ref}>
      <BenchmarkEvidence />
    </div>
  );
}
