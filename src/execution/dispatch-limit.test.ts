import { describe, it, expect } from 'vitest';
import { createLimiter, maxConcurrentFromEnv, DEFAULT_MAX_CONCURRENT } from './dispatch-limit.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

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