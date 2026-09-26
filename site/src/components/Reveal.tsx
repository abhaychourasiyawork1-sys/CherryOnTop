import { useEffect, useRef, useState, type JSX } from 'react';
import { useReducedMotion } from '../hooks/useReducedMotion';

export function Reveal(props: {
  children: React.ReactNode;
  once?: boolean;
  threshold?: number;
}): JSX.Element {
  const { children, once = true, threshold = 0.2 } = props;
  const ref = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const [visible, setVisible] = useState(reducedMotion);

  useEffect(() => {
    if (reducedMotion) {
      setVisible(true);
      return;
    }
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            if (once) {
              observer.disconnect();
            }
          } else if (!once) {
            setVisible(false);
          }
        }
      },
      { threshold },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [once, threshold, reducedMotion]);

  return (
    <div ref={ref} className={`reveal${visible || reducedMotion ? ' reveal--visible' : ''}`}>
      {children}
    </div>
  );
}
