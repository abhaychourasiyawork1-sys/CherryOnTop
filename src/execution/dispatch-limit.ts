/** Bounds how many sandboxes run at once.
 *
 *  A fan-out starts every child at the same moment, and each child plans in its
 *  own sandbox before it works — so one task could put eight concurrent runs
 *  against the model API and spend a five-hour usage window in minutes. The
 *  organization is not faster for it: the quota is the bottleneck, not the
 *  cluster. Queueing keeps the same work inside a budget that survives it. */
export interface Limiter {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** How many callers are waiting for a slot. A node that is queued rather than
   *  working should be able to say so. */
  queued(): number;
  active(): number;
}

export const DEFAULT_MAX_CONCURRENT = 2;

/** The daemon-wide limiter, shared by every sandbox dispatch. Exported so the
 *  daemon can report how many are running and how many are waiting — without
 *  that, "is it stuck or is it queued?" can only be guessed at from pod counts,
 *  which outlive their jobs and mislead. */
let shared: Limiter | null = null;

export function sandboxLimiter(): Limiter {
  shared ??= createLimiter(maxConcurrentFromEnv());
  return shared;
}

export function maxConcurrentFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ORG_MAX_CONCURRENT_SANDBOXES;
  if (raw === undefined) return DEFAULT_MAX_CONCURRENT;
  const value = Number(raw);
  // A bad value must not silently disable the limit — that is the failure mode
  // this exists to prevent.
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_MAX_CONCURRENT;
}

export function createLimiter(max: number): Limiter {
  const ceiling = Math.max(1, Math.floor(max));
  const waiting: (() => void)[] = [];
  let running = 0;

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (running >= ceiling) {
        // The slot is *transferred* to us by whoever released it, so `running`
        // already counts us and must not be incremented again here.
        await new Promise<void>((resolve) => waiting.push(resolve));
      } else {
        running++;
      }
      try {
        return await task();
      } finally {
        // Hand the slot straight to the next waiter rather than freeing it and
        // hoping they win the race for it. Decrementing first leaves a window in
        // which a caller arriving at that moment sees a free slot and takes the
        // one already promised — which is how concurrency crept above the
        // ceiling.
        const next = waiting.shift();
        if (next) next();
        else running--;
      }
    },
    queued: () => waiting.length,
    active: () => running,
  };
}
