import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function getMediaQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(QUERY) ?? null;
}

/** Tracks `prefers-reduced-motion: reduce`, subscribing to changes while mounted. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => getMediaQuery()?.matches === true);

  useEffect(() => {
    const query = getMediaQuery();
    if (!query) return undefined;
    const onChange = () => setReduced(query.matches);
    onChange();
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    }
    query.addListener?.(onChange);
    return () => query.removeListener?.(onChange);
  }, []);

  return reduced;
}
