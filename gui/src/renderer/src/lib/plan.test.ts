import { describe, it, expect } from 'vitest';
import { planOf } from './plan.js';
import { node } from './fixtures.js';

describe('plan', () => {
  it('a delegating root’s plan is its children, in order', () => {
    const root = node({ id: 'r', state: 'DELEGATE', childCount: 3 });
    const plan = planOf(root, [
      root,
      node({ id: 'b', parentId: 'r', goal: 'Remove duplicate validation.', state: 'SELF_EXECUTE', createdAt: '2026-09-01T00:00:02Z' }),
      node({ id: 'a', parentId: 'r', goal: 'Understand auth architecture', createdAt: '2026-09-01T00:00:01Z' }),
      node({ id: 'c', parentId: 'r', goal: 'Verify callers', state: 'CREATED', createdAt: '2026-09-01T00:00:03Z' }),
      node({ id: 'c1', parentId: 'c', state: 'CREATED' }),
    ], []);
    expect(plan.source).toBe('agents');
    expect(plan.steps.map((s) => [s.title, s.status])).toEqual([
      ['Understand auth architecture', 'done'],
      ['Remove duplicate validation', 'active'],
      ['Verify callers', 'pending'],
    ]);
    expect(plan.steps[2].depth).toBe(1);
  });

  it('keeps an abandoned step traceable as a revision', () => {
    const root = node({ id: 'r', state: 'DELEGATE', childCount: 2 });
    const plan = planOf(root, [
      root,
      node({ id: 'old', parentId: 'r', goal: 'Rewrite session handler', state: 'FAILED', supersededBy: 'new' }),
      node({ id: 'new', parentId: 'r', goal: 'Rewrite session handler', state: 'SELF_EXECUTE' }),
    ], []);
    expect(plan.steps.find((s) => s.id === 'old')).toMatchObject({ status: 'replaced', replacedBy: 'new' });
    expect(plan.revisions).toEqual([expect.objectContaining({ change: 'replaced', what: 'Rewrite session handler' })]);
  });

  it('explains pruned template steps', () => {
    const root = node({ id: 'r', state: 'SELF_EXECUTE' });
    const plan = planOf(root, [root], [{
      id: 5, nodeId: 'r', type: 'execution.plan', createdAt: '2026-09-01T00:00:00Z',
      payload: { steps: [{ name: 'locate the relevant code' }, { name: 'make the change' }], removed: [{ name: 'retrieve context', reason: 'context is already known' }] },
    }]);
    expect(plan.source).toBe('template');
    expect(plan.steps.map((s) => [s.title, s.status])).toEqual([['Locate the relevant code', 'done'], ['Make the change', 'active']]);
    expect(plan.revisions[0]).toMatchObject({ change: 'removed', what: 'retrieve context', reason: 'context is already known' });
  });

  it('has nothing to show before the runtime has planned', () => {
    const root = node({ id: 'r', state: 'CREATED' });
    expect(planOf(root, [root], []).source).toBe('none');
  });
});
