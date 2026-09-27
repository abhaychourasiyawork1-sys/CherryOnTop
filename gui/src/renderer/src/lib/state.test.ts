import { describe, it, expect } from 'vitest';
import { toneOf, labelOf } from './state.js';

describe('toneOf', () => {
  it('reads a plain failure as failed', () => {
    expect(toneOf('FAILED')).toBe('failed');
  });

  it('reads a superseded failure as settled, not failed', () => {
    // A parent already replaced this child with a fresh one — the honest
    // history stays FAILED, but a red leaf here would tell a person watching
    // that something still needs their attention, which it doesn't.
    expect(toneOf('FAILED', 'replacement-id')).toBe('settled');
  });

  it('ignores supersededBy on any state other than FAILED', () => {
    expect(toneOf('COMPLETE', 'replacement-id')).toBe('settled');
    expect(toneOf('SELF_EXECUTE', 'replacement-id')).toBe('executing');
  });
});

describe('labelOf', () => {
  it('labels a superseded failure as replaced', () => {
    expect(labelOf('FAILED', 'replacement-id')).toBe('Replaced');
  });

  it('labels a plain failure as failed', () => {
    expect(labelOf('FAILED')).toBe('Failed');
    expect(labelOf('FAILED', null)).toBe('Failed');
  });
});
