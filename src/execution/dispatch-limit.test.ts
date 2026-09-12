import { describe, it, expect } from 'vitest';
import { createLimiter, maxConcurrentFromEnv, DEFAULT_MAX_CONCURRENT, CRITICAL_PATH } from './dispatch-limit.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('critical-path ordering', () => {
  // The queue is FIFO, and the two things in it are not comparable. A planning
  // dispatch is capped at 2 turns and blocks the creation of every child — it
  // is the critical path of the whole task. A synthesis dispatch is capped at 1
  // turn and is the last thing between a person and their answer. A work
  // dispatch may run 60 turns and blocks only itself. One measured run left a
  // dispatch waiting 4m22s behind work of exactly that shape.
  it('hands a freed slot to coordination work ahead of queued work dispatches', async () => {
    const limiter = createLimiter(1);
    const order: string[] = [];
    const gates = [deferred(), deferred(), deferred(), deferred()];

    const runs = [
      limiter.run(async () => { order.push('holder'); await gates[0].promise; }),
      limiter.run(async () => { order.push('work-a'); await gates[1].promise; }),
      limiter.run(async () => { order.push('work-b'); await gates[2].promise; }),
      limiter.run(async () => { order.push('plan'); await gates[3].promise; }, CRITICAL_PATH),
    ];

    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(['holder']);
    for (const gate of gates) gate.resolve();
    await Promise.all(runs);

    // Queued last, run first — and the two work dispatches keep their own order
    // relative to each other.
    expect(order).toEqual(['holder', 'plan', 'work-a', 'work-b']);
  });

  it('stays first-in-first-out among equals', async () => {
    const limiter = createLimiter(1);
    const order: number[] = [];
    const gates = [deferred(), deferred(), deferred()];
    const runs = gates.map((gate, i) =>
      limiter.run(async () => { order.push(i); await gate.promise; }, CRITICAL_PATH));

    await new Promise((r) => setTimeout(r, 5));
    for (const gate of gates) gate.resolve();
    await Promise.all(runs);
    expect(order).toEqual([0, 1, 2]);
  });

  it('never lets priority raise the ceiling', async () => {
    // Reordering the queue is the whole change. A scheduler that degrades has
    // to degrade to the configured concurrency, not past it.
    const limiter = createLimiter(2);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const runs = gates.map((gate, i) => limiter.run(async () => { await gate.promise; }, i % 2 ? CRITICAL_PATH : 0));

    await new Promise((r) => setTimeout(r, 5));
    expect(limiter.active()).toBe(2);
    for (const gate of gates) gate.resolve();
    await Promise.all(runs);
  });
});

describe('createLimiter', () => {
  it('never runs more than the ceiling at once', async () => {
    const limiter = createLimiter(2);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    let peak = 0;

    const runs = gates.map((gate) => limiter.run(async () => {
      peak = Math.max(peak, limiter.active());
      await gate.promise;
    }));

    await new Promise((r) => setTimeout(r, 5));
    expect(limiter.active()).toBe(2);
    expect(limiter.queued()).toBe(2);

    for (const gate of gates) gate.resolve();
    await Promise.all(runs);
    expect(peak).toBe(2);
  });

  it('hands a freed slot to the next waiter in turn', async () => {
    const limiter = createLimiter(1);
    const order: number[] = [];
    const gates = [deferred(), deferred(), deferred()];
    const runs = gates.map((gate, index) => limiter.run(async () => { order.push(index); await gate.promise; }));

    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual([0]);
    gates[0].resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual([0, 1]);
    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(runs);
    expect(order).toEqual([0, 1, 2]);
  });

  it('releases the slot when a task throws, or one failure would wedge everything', async () => {
    const limiter = createLimiter(1);
    await expect(limiter.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(limiter.active()).toBe(0);
    await expect(limiter.run(async () => 'fine')).resolves.toBe('fine');
  });

  it('treats a nonsense ceiling as one rather than as unlimited', async () => {
    const limiter = createLimiter(0);
    const gate = deferred();
    const first = limiter.run(async () => { await gate.promise; });
    await new Promise((r) => setTimeout(r, 5));
    expect(limiter.active()).toBe(1);
    gate.resolve();
    await first;
  });

  it('returns the task’s value', async () => {
    await expect(createLimiter(2).run(async () => 42)).resolves.toBe(42);
  });
});

describe('maxConcurrentFromEnv', () => {
  it('defaults when unset', () => {
    expect(maxConcurrentFromEnv({})).toBe(DEFAULT_MAX_CONCURRENT);
  });

  it('honours an explicit limit', () => {
    expect(maxConcurrentFromEnv({ ORG_MAX_CONCURRENT_SANDBOXES: '5' })).toBe(5);
  });

  it('falls back to the default rather than disabling the limit', () => {
    // A typo must not remove the bound — that is the failure this prevents.
    expect(maxConcurrentFromEnv({ ORG_MAX_CONCURRENT_SANDBOXES: 'lots' })).toBe(DEFAULT_MAX_CONCURRENT);
    expect(maxConcurrentFromEnv({ ORG_MAX_CONCURRENT_SANDBOXES: '0' })).toBe(DEFAULT_MAX_CONCURRENT);
    expect(maxConcurrentFromEnv({ ORG_MAX_CONCURRENT_SANDBOXES: '-3' })).toBe(DEFAULT_MAX_CONCURRENT);
  });
});