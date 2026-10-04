import { describe, it, expect, afterEach } from 'vitest';
import { modelForTier } from './efficiency.js';

afterEach(() => {
  for (const key of ['ORG_MODEL_FAST', 'ORG_MODEL_STANDARD', 'ORG_MODEL_DEEP']) delete process.env[key];
});

describe('there is no runtime mode', () => {
  it('exports no switch that selects a different architecture', async () => {
    // One production architecture. A mode switch — baseline/full, shadow,
    // routing on/off — is exactly what the Action Market replaced.
    const config = await import('./efficiency.js') as Record<string, unknown>;
    expect(config.runtimeMode).toBeUndefined();
    expect(config.parseRuntimeMode).toBeUndefined();
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
