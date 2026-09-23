import { describe, it, expect, afterEach } from 'vitest';
import { parseRuntimeMode, runtimeMode, modelForTier } from './efficiency.js';

afterEach(() => {
  delete process.env.ORG_EFFICIENCY_MODE;
  for (const key of ['ORG_MODEL_FAST', 'ORG_MODEL_STANDARD', 'ORG_MODEL_DEEP']) delete process.env[key];
});

describe('parseRuntimeMode', () => {
  it('exposes exactly two product modes', () => {
    // The architectural invariant, asserted where it is decided. A third mode
    // is one more behaviour an operator can be in, one more combination to
    // test, and one more thing a bug report has to establish before it can be
    // read.
    const modes = new Set(
      ['disabled', 'off', '0', 'false', 'baseline', 'shadow', 'enabled', 'full', '', 'anything', undefined]
        .map((value) => parseRuntimeMode(value as string | undefined)),
    );
    expect([...modes].sort()).toEqual(['baseline', 'full']);
  });

  it('accepts the ways people actually write "off"', () => {
    for (const value of ['off', '0', 'false', 'DISABLED', ' disabled ', 'baseline']) {
      expect(parseRuntimeMode(value)).toBe('baseline');
    }
  });

  it('resolves the retired shadow mode to the behaviour it actually had', () => {
    // A shadow run decided, recorded, and then dispatched exactly as a disabled
    // run would. A deployment that set it keeps what it had and stops being in
    // a mode nobody else is in.
    expect(parseRuntimeMode('shadow')).toBe('baseline');
  });

  it('defaults to full, including for an unset or unrecognised value', () => {
    // Every component this gates degrades to Baseline on failure, and a flag
    // nobody turns on measures nothing.
    expect(parseRuntimeMode(undefined)).toBe('full');
    expect(parseRuntimeMode('')).toBe('full');
    expect(parseRuntimeMode('yes-please')).toBe('full');
  });

  it('reads the environment', () => {
    process.env.ORG_EFFICIENCY_MODE = 'disabled';
    expect(runtimeMode()).toBe('baseline');
  });
});

describe('modelForTier', () => {
  it('tiers down by default and refuses to tier up without being told to', () => {
    expect(modelForTier('fast')).toBe('haiku');
    // Undefined means no --model flag: whatever the runtime would use anyway.
    expect(modelForTier('standard')).toBeUndefined();
    expect(modelForTier('deep')).toBeUndefined();
  });

  it('lets an operator name any tier', () => {
    process.env.ORG_MODEL_DEEP = 'opus';
    process.env.ORG_MODEL_STANDARD = 'sonnet';
    expect(modelForTier('deep')).toBe('opus');
    expect(modelForTier('standard')).toBe('sonnet');
  });

  it('treats the disabling words as "no model"', () => {
    process.env.ORG_MODEL_FAST = 'none';
    expect(modelForTier('fast')).toBeUndefined();
  });
});
