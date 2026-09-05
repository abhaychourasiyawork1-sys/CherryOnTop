import { describe, it, expect, vi } from 'vitest';
import { delegateToChild, childAuthority } from './delegate-child.js';
import type { Authority } from '../schemas/node-contract.js';

describe('delegateToChild', () => {
  it('creates a child node with a budget carved from the parent, then awaits it', async () => {
    const calls: string[] = [];
    const deps = {
      createChildNode: vi.fn((parentId: string, _goal: string, budgetUsd: number) => {
        calls.push(`create:${parentId}:${budgetUsd}`);
        return 'child-1';
      }),
      recordCommitment: vi.fn((childId: string) => { calls.push(`commit:${childId}`); }),
      startChild: vi.fn((childId: string) => { calls.push(`start:${childId}`); }),
      waitForChild: vi.fn(async (childId: string) => { calls.push(`wait:${childId}`); return { succeeded: true }; }),
    };

    const result = await delegateToChild({ parentId: 'n1', goal: 'delegated goal', childBudgetUsd: 1 }, deps);

    expect(result.succeeded).toBe(true);
    expect(calls).toEqual(['create:n1:1', 'commit:child-1', 'start:child-1', 'wait:child-1']);
  });

  it('reports failure when the child does not succeed', async () => {
    const deps = {
      createChildNode: vi.fn(() => 'child-1'),
      recordCommitment: vi.fn(() => {}),
      startChild: vi.fn(() => {}),
      waitForChild: vi.fn(async () => ({ succeeded: false })),
    };

    const result = await delegateToChild({ parentId: 'n1', goal: 'delegated goal', childBudgetUsd: 1 }, deps);
    expect(result.succeeded).toBe(false);
  });
});

describe('childAuthority', () => {
  const parent: Authority = { tools: ['git'], spawn_children: true, max_child_count: 2, budget_usd: 10 };

  it('spends one of max_child_count per generation, so delegation depth is bounded', () => {
    const child = childAuthority(parent, 1);
    expect(child.max_child_count).toBe(1);
    expect(child.spawn_children).toBe(true);

    const grandchild = childAuthority(child, 1);
    expect(grandchild.max_child_count).toBe(0);
    expect(grandchild.spawn_children).toBe(false);
  });

  it('withholds spawn authority the child could never afford to use', () => {
    // The parent's budget caps the child's below the cost of one child, so
    // granting spawn authority would only send the child straight to ESCALATE.
    const poor = childAuthority({ ...parent, budget_usd: 0.5 }, 1);
    expect(poor.budget_usd).toBe(0.5);
    expect(poor.spawn_children).toBe(false);
  });

  it('lets a human approval lift the child budget above the parent', () => {
    expect(childAuthority({ ...parent, budget_usd: 0.5 }, 1, 1).budget_usd).toBe(1);
  });

  it('never widens tools beyond the parent', () => {
    expect(childAuthority({ ...parent, tools: ['git'] }, 1).tools).toEqual(['git']);
  });
});
