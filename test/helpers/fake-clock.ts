export interface FakeClock {
  now(): number;
  advance(milliseconds: number): void;
}

export function createFakeClock(start = 0): FakeClock {
  let time = start;
  return {
    now: () => time,
    advance(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new RangeError('milliseconds must be finite and non-negative');
      time += milliseconds;
    },
  };
}
