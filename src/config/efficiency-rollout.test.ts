import { describe, it, expect, afterEach } from 'vitest';
import { parseEfficiencyMode, efficiencyMode, modelForTier } from './efficiency.js';

afterEach(() => {
  delete process.env.ORG_EFFICIENCY_MODE;
  for (const key of ['ORG_MODEL_FAST', 'ORG_MODEL_STANDARD', 'ORG_MODEL_DEEP']) delete process.env[key];
});

describe('parseEfficiencyMode', () => {
  it('supports the three rollout modes', () => {
    expect(parseEfficiencyMode('disabled')).toBe('disabled');
    expect(parseEfficiencyMode('shadow')).toBe('shadow');
    expect(parseEfficiencyMode('enabled')).toBe('enabled');
  });

  it('accepts the ways people actually write "off"', () => {
    for (const value of ['off', '0', 'false', 'DISABLED', ' disabled ']) {
      expect(parseEfficiencyMode(value)).toBe('disabled');
    }
  });

  it('defaults to enabled, including for an unset or unrecognised value', () => {
    // Every component this gates degrades to the previous behaviour on failure,
    // and a flag nobody turns on measures nothing.
    expect(parseEfficiencyMode(undefined)).toBe('enabled');
    expect(parseEfficiencyMode('')).toBe('enabled');
    expect(parseEfficiencyMode('yes-please')).toBe('enabled');
  });

  it('reads the environment', () => {
    process.env.ORG_EFFICIENCY_MODE = 'shadow';
    expect(efficiencyMode()).toBe('shadow');
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
