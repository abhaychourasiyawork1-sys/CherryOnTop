export interface RateLimiterOptions {
  windowMs: number;
  max: number;
}

export interface RateLimiter {
  consume(key: string): boolean;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const hits = new Map<string, number[]>();

  return {
    consume(key: string): boolean {
      const now = Date.now();
      const recent = (hits.get(key) ?? []).filter((timestamp) => now - timestamp < options.windowMs);
      recent.push(now);
      hits.set(key, recent);
      return recent.length <= options.max;
    },
  };
}
