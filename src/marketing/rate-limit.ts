export interface RateLimiterOptions {
  windowMs: number;
  max: number;
}

export interface RateLimiter {
  consume(key: string): boolean;
  /** Number of client keys currently held in memory (for tests/diagnostics). */
  size(): number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const hits = new Map<string, number[]>();
  let lastSweep = Date.now();

  // Client keys are IPs: drop them once their window expires so they are never retained indefinitely
  // and rotating-address traffic cannot grow the map without bound.
  function sweep(now: number): void {
    for (const [key, timestamps] of hits) {
      const latest = timestamps[timestamps.length - 1];
      if (latest === undefined || now - latest >= options.windowMs) {
        hits.delete(key);
      }
    }
    lastSweep = now;
  }

  return {
    consume(key: string): boolean {
      const now = Date.now();
      if (now - lastSweep >= options.windowMs) {
        sweep(now);
      }
      const recent = (hits.get(key) ?? []).filter((timestamp) => now - timestamp < options.windowMs);
      if (recent.length >= options.max) {
        // Rejected hits are not recorded, so a flood cannot grow a single key's history past `max`.
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      return true;
    },
    size(): number {
      return hits.size;
    },
  };
}
