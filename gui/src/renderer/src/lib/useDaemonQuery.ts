import { useEffect, useState } from 'react';

/** One read from the daemon, with the cancelled-on-unmount dance done once.
 *
 *  Six panels had grown their own copy of this effect. The version that matters
 *  is the guard: a slow query that resolves after the user has moved on must not
 *  write into a component that is gone.
 *
 *  `deps` re-runs the read, exactly like useEffect's. */
export function useDaemonQuery<T>(
  run: () => Promise<T>,
  deps: unknown[],
): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    run()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { data, error, loading, reload: () => setTick((n) => n + 1) };
}
