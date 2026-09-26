import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from './rate-limit.js';

describe('createRateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows up to max hits per window, then rejects until the window passes', () => {
    vi.useFakeTimers();
    const limiter = createRateLimiter({ windowMs: 1_000, max: 2 });
    expect(limiter.consume('a')).toBe(true);
    expect(limiter.consume('a')).toBe(true);
    expect(limiter.consume('a')).toBe(false);
    expect(limiter.consume('b')).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(limiter.consume('a')).toBe(true);
  });

  it('keeps rejecting a sustained flood without extending the key history', () => {
    vi.useFakeTimers();
    const limiter = createRateLimiter({ windowMs: 1_000, max: 2 });
    limiter.consume('a');
    limiter.consume('a');
    for (let i = 0; i < 100; i += 1) {
      expect(limiter.consume('a')).toBe(false);
    }
    vi.advanceTimersByTime(1_000);
    expect(limiter.consume('a')).toBe(true);
  });

  it('evicts client keys whose window has expired', () => {
    vi.useFakeTimers();
    const limiter = createRateLimiter({ windowMs: 1_000, max: 5 });
    for (let i = 0; i < 50; i += 1) {
      limiter.consume(`203.0.113.${i}`);
    }
    expect(limiter.size()).toBe(50);
    vi.advanceTimersByTime(1_000);
    limiter.consume('198.51.100.1');
    expect(limiter.size()).toBe(1);
  });
});
