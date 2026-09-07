import { describe, it, expect } from 'vitest';
import { money, duration, ago, basename, clip } from './format.js';

describe('format', () => {
  it('formats money to cents by default', () => {
    expect(money(1.5)).toBe('$1.50');
    expect(money(0.0031, 4)).toBe('$0.0031');
  });

  it('steps duration up a unit only when the smaller one stops being readable', () => {
    expect(duration(5_000)).toBe('5s');
    expect(duration(65_000)).toBe('1m 5s');
    expect(duration(3_665_000)).toBe('1h 1m');
  });

  it('reads a timestamp the way a person would say it', () => {
    const now = Date.parse('2026-09-07T12:00:00.000Z');
    expect(ago('2026-09-07T11:59:50.000Z', now)).toBe('just now');
    expect(ago('2026-09-07T11:30:00.000Z', now)).toBe('30m ago');
    expect(ago('2026-09-07T09:00:00.000Z', now)).toBe('3h ago');
    expect(ago('2026-09-05T12:00:00.000Z', now)).toBe('2d ago');
  });

  it('never breaks a word in half when clipping', () => {
    expect(clip('the quick brown fox jumps', 12)).toBe('the quick…');
    expect(clip('short', 12)).toBe('short');
  });

  it('takes a repository name off a path with or without a trailing slash', () => {
    expect(basename('/home/me/CherryOnTop')).toBe('CherryOnTop');
    expect(basename('/home/me/CherryOnTop/')).toBe('CherryOnTop');
  });
});
