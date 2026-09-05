import { describe, it, expect, vi } from 'vitest';
import { delegateToChild } from './delegate-child.js';

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
