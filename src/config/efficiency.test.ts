import { describe, it, expect, afterEach } from 'vitest';
import { dispatchOptionsFor, planCacheTtlHours, repoMapTokenBudget, rolePromptsEnabled } from './efficiency.js';

const KEYS = [
  'ORG_MODEL_PLAN', 'ORG_MODEL_EXECUTE', 'ORG_MODEL_SYNTHESIZE',
  'ORG_MAX_TURNS_PLAN', 'ORG_MAX_TURNS_SYNTHESIZE',
  'ORG_PLAN_CACHE_TTL_HOURS', 'ORG_REPO_MAP_TOKENS', 'ORG_ROLE_PROMPTS',
];
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

describe('dispatchOptionsFor', () => {
  it('defaults plan and synthesize to haiku with turn caps, execute to no model', () => {
    expect(dispatchOptionsFor('plan')).toEqual({ model: 'haiku', maxTurns: 2 });
    expect(dispatchOptionsFor('synthesize')).toEqual({ model: 'haiku', maxTurns: 1 });
    expect(dispatchOptionsFor('execute')).toEqual({});
  });


  it('lets env vars override the model per role', () => {
    process.env.ORG_MODEL_PLAN = 'sonnet';
    process.env.ORG_MODEL_EXECUTE = 'haiku';
    expect(dispatchOptionsFor('plan').model).toBe('sonnet');
    expect(dispatchOptionsFor('execute').model).toBe('haiku');
  });

  it('treats an empty / "default" / "none" model env var as "no --model"', () => {
    process.env.ORG_MODEL_PLAN = 'none';
    expect(dispatchOptionsFor('plan').model).toBeUndefined();
  });

  it('lets env vars override the turn caps and ignores non-numbers', () => {
    process.env.ORG_MAX_TURNS_PLAN = '30';
    process.env.ORG_MAX_TURNS_SYNTHESIZE = 'oops';
    expect(dispatchOptionsFor('plan').maxTurns).toBe(30);
    expect(dispatchOptionsFor('synthesize').maxTurns).toBe(1);
  });
});

describe('scalar knobs', () => {
  it('planCacheTtlHours defaults to 24 and clamps junk to the default', () => {
    expect(planCacheTtlHours()).toBe(24);
    process.env.ORG_PLAN_CACHE_TTL_HOURS = '0';
    expect(planCacheTtlHours()).toBe(0);
    process.env.ORG_PLAN_CACHE_TTL_HOURS = 'x';
    expect(planCacheTtlHours()).toBe(24);
  });

  it('repoMapTokenBudget defaults to 6000, 0 disables', () => {
    expect(repoMapTokenBudget()).toBe(6000);
    process.env.ORG_REPO_MAP_TOKENS = '0';
    expect(repoMapTokenBudget()).toBe(0);
  });

  it('rolePromptsEnabled defaults true, "off"/"0"/"false" disable', () => {
    expect(rolePromptsEnabled()).toBe(true);
    for (const v of ['off', '0', 'false', 'no']) {
      process.env.ORG_ROLE_PROMPTS = v;
      expect(rolePromptsEnabled()).toBe(false);
    }
  });
});
