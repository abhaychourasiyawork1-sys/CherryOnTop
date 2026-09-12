/** Bounds how many sandboxes run at once.
 *
 *  A fan-out starts every child at the same moment, and each child plans in its
 *  own sandbox before it works — so one task could put eight concurrent runs
 *  against the model API and spend a five-hour usage window in minutes. The
 *  organization is not faster for it: the quota is the bottleneck, not the
 *  cluster. Queueing keeps the same work inside a budget that survives it. */
export interface Limiter {
  /** `priority` reorders the *queue* only; it can never raise the ceiling.
   *  Higher goes first, equals stay first-in-first-out. */
  run<T>(task: () => Promise<T>, priority?: number): Promise<T>;
  /** How many callers are waiting for a slot. A node that is queued rather than
   *  working should be able to say so. */
  queued(): number;
  active(): number;
}

export const DEFAULT_MAX_CONCURRENT = 2;

/** The priority for a dispatch that blocks more than itself.
 *
 *  The queue holds two things that are not comparable. A planning dispatch is
 *  capped at 2 turns and nothing can start until it answers — it is the critical
 *  path of the whole task. A synthesis dispatch is capped at 1 turn and is the
 *  last thing between a person and their answer. A work dispatch may run 60
 *  turns and blocks only itself. Letting a one-turn synthesis wait behind a
 *  sixty-turn execution is not fairness, it is a scheduling error: in one
 *  measured run a dispatch spent 4m22s in exactly that queue.
 *
 *  Ordering only. The concurrency ceiling is untouched, so the worst this can
 *  degrade to is the first-in-first-out behaviour it replaced. */
export const CRITICAL_PATH = 1;

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
  const waiting: { resolve: () => void; priority: number }[] = [];
  let running = 0;

  /** The longest-waiting of the highest-priority waiters. A linear scan rather
   *  than a heap: the queue is bounded by how many nodes are in flight, which is
   *  a handful, and a heap here would be a data structure for its own sake. */
  const takeNext = (): (() => void) | undefined => {
    if (waiting.length === 0) return undefined;
    let best = 0;
    for (let i = 1; i < waiting.length; i++) {
      if (waiting[i].priority > waiting[best].priority) best = i;
    }
    return waiting.splice(best, 1)[0].resolve;
  };

  return {
    async run<T>(task: () => Promise<T>, priority = 0): Promise<T> {
      if (running >= ceiling) {
        // The slot is *transferred* to us by whoever released it, so `running`
        // already counts us and must not be incremented again here.
        await new Promise<void>((resolve) => waiting.push({ resolve, priority }));
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
        const next = takeNext();
        if (next) next();
        else running--;
      }
    },
    queued: () => waiting.length,
    active: () => running,
  };
}
