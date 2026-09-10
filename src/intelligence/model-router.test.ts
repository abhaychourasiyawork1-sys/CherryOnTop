import { describe, it, expect, afterEach } from 'vitest';
import { routeModel } from './model-router.js';

afterEach(() => {
  for (const key of ['ORG_MODEL_FAST', 'ORG_MODEL_STANDARD', 'ORG_MODEL_DEEP', 'ORG_MODEL_EXECUTE', 'ORG_MODEL_PLAN']) {
    delete process.env[key];
  }
});

const healthy = { budgetUsd: 10, spentUsd: 0 };

describe('routeModel', () => {
  it('keeps the two narrow roles on the fast tier', () => {
    expect(routeModel({ role: 'plan', complexity: 'high', ...healthy }).tier).toBe('fast');
    expect(routeModel({ role: 'synthesize', complexity: 'high', ...healthy }).tier).toBe('fast');
  });

  it('tiers a trivial piece of work down', () => {
    const route = routeModel({ role: 'execute', complexity: 'low', ...healthy });
    expect(route.tier).toBe('fast');
    expect(route.model).toBe('haiku');
    expect(route.reason).toContain('low');
  });

  it('leaves real work on the runtime default', () => {
    for (const complexity of ['medium', 'high'] as const) {
      const route = routeModel({ role: 'execute', complexity, ...healthy });
      expect(route.tier).toBe('standard');
      // Undefined means no --model flag at all: whatever the runtime would have
      // used anyway. Tiering up is a cost increase nobody asked for.
      expect(route.model).toBeUndefined();
    }
  });

  it('uses a deep tier only when an operator has named one', () => {
    expect(routeModel({ role: 'execute', complexity: 'high', ...healthy }).tier).toBe('standard');
    process.env.ORG_MODEL_DEEP = 'opus';
    const route = routeModel({ role: 'execute', complexity: 'high', ...healthy });
    expect(route.tier).toBe('deep');
    expect(route.model).toBe('opus');
  });

  it('drops to the fast tier when the budget is nearly gone', () => {
    process.env.ORG_MODEL_DEEP = 'opus';
    const route = routeModel({ role: 'execute', complexity: 'high', budgetUsd: 10, spentUsd: 9.5 });
    expect(route.tier).toBe('fast');
    expect(route.reason).toContain('budget');
  });

  it('does not read budget pressure into a node with no budget at all', () => {
    // budget_usd of 0 is "no budget assigned", not "budget exhausted" — the
    // difference between a node nobody costed and a node that overspent.
    const route = routeModel({ role: 'execute', complexity: 'medium', budgetUsd: 0, spentUsd: 0 });
    expect(route.tier).toBe('standard');
  });

  it('lets an explicit per-role model override the routing entirely', () => {
    process.env.ORG_MODEL_EXECUTE = 'sonnet';
    const route = routeModel({ role: 'execute', complexity: 'low', ...healthy });
    expect(route.model).toBe('sonnet');
    expect(route.reason).toContain('ORG_MODEL_EXECUTE');
  });

  it('honours an explicit override even when it names no model', () => {
    process.env.ORG_MODEL_EXECUTE = 'none';
    const route = routeModel({ role: 'execute', complexity: 'low', ...healthy });
    expect(route.model).toBeUndefined();
  });

  it('lets the tier models be renamed', () => {
    process.env.ORG_MODEL_FAST = 'claude-haiku-4-5-20251001';
    expect(routeModel({ role: 'plan', complexity: 'low', ...healthy }).model).toBe('claude-haiku-4-5-20251001');
  });

  it('always explains itself', () => {
    for (const complexity of ['low', 'medium', 'high'] as const) {
      expect(routeModel({ role: 'execute', complexity, ...healthy }).reason.length).toBeGreaterThan(0);
    }
  });
});
