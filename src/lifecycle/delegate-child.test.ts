import { describe, it, expect, vi } from 'vitest';
import { delegateToChildren, childAuthority } from './delegate-child.js';
import type { Authority } from '../schemas/node-contract.js';

function spyDeps(succeed: (goal: string) => boolean = () => true) {
  const calls: string[] = [];
  let next = 0;
  return {
    calls,
    deps: {
      createChildNode: vi.fn((parentId: string, goal: string, siblingCount: number) => {
        const id = `child-${++next}`;
        calls.push(`create:${parentId}:${siblingCount}:${goal}`);
        return id;
      }),
      recordCommitment: vi.fn((childId: string, goal: string) => { calls.push(`commit:${childId}:${goal}`); }),
      startChild: vi.fn((childId: string, goal: string) => { calls.push(`start:${childId}:${goal}`); }),
      waitForChild: vi.fn(async (childId: string) => {
        calls.push(`wait:${childId}`);
        const index = Number(childId.split('-')[1]) - 1;
        const goal = calls.filter((c) => c.startsWith('start:'))[index]?.split(':').slice(2).join(':') ?? '';
        return { succeeded: succeed(goal) };
      }),
    },
  };
}

describe('delegateToChildren', () => {
  it('gives each child its own subgoal, not a copy of the parent’s', async () => {
    // The bug this replaced: one child created with the parent's goal verbatim,
    // which re-decided to delegate and cloned itself again, generation after
    // generation, spending budget to accomplish nothing.
    const { calls, deps } = spyDeps();
    const result = await delegateToChildren(
      { parentId: 'n1', goal: 'Review the codebase', subgoals: ['Audit auth', 'Add cart tests'] },
      deps,
    );

    expect(result.succeeded).toBe(true);
    // Two subgoals, so each child is told it is one of two — which is what
    // decides its share of the parent's agents and budget.
    expect(calls.filter((c) => c.startsWith('create:'))).toEqual([
      'create:n1:2:Audit auth',
      'create:n1:2:Add cart tests',
    ]);
    expect(calls).not.toContain('create:n1:2:Review the codebase');
  });

  it('starts every child before waiting on any of them', async () => {
    // Waiting on each in turn would make a fan-out take as long as a chain.
    const { calls, deps } = spyDeps();
    await delegateToChildren(
      { parentId: 'n1', goal: 'g', subgoals: ['a', 'b', 'c'] },
      deps,
    );
    const firstWait = calls.findIndex((c) => c.startsWith('wait:'));
    const lastStart = calls.map((c) => c.startsWith('start:')).lastIndexOf(true);
    expect(lastStart).toBeLessThan(firstWait);
  });

  it('refuses to delegate a goal that did not split, rather than cloning it', async () => {
    const { calls, deps } = spyDeps();
    const result = await delegateToChildren(
      { parentId: 'n1', goal: 'Rename one variable', subgoals: [] },
      deps,
    );
    expect(result.succeeded).toBe(false);
    expect(result.message).toContain('did not split');
    // The flag is what stops the machine retrying delegation: without it, VERIFY
    // treats this as a failure, re-decides, re-plans, and pays for a sandbox on
    // every pass to reach the same answer.
    expect(result.notDelegatable).toBe(true);
    expect(calls).toEqual([]);
  });

  it('refuses to split a second time when it has already delegated', async () => {
    // Observed live: a fan-out where one piece came back unfinished sent the
    // machine round again, and it created a whole second set of children with
    // the same subgoals — re-doing the pieces that had already completed.
    const { calls, deps } = spyDeps();
    const result = await delegateToChildren(
      { parentId: 'n1', goal: 'g', subgoals: ['a', 'b'], existingChildren: 3 },
      deps,
    );
    expect(result.succeeded).toBe(false);
    expect(result.notDelegatable).toBe(true);
    expect(result.message).toContain('already split across 3 agents');
    expect(calls).toEqual([]);
  });

  it('ignores blank subgoals a planner may have emitted', async () => {
    const { calls, deps } = spyDeps();
    await delegateToChildren(
      { parentId: 'n1', goal: 'g', subgoals: ['real work', '   '] },
      deps,
    );
    expect(calls.filter((c) => c.startsWith('create:'))).toHaveLength(1);
  });

  it('fails when any sibling fails, and names which', async () => {
    const { deps } = spyDeps((goal) => goal !== 'Add cart tests');
    const result = await delegateToChildren(
      { parentId: 'n1', goal: 'g', subgoals: ['Audit auth', 'Add cart tests'] },
      deps,
    );
    expect(result.succeeded).toBe(false);
    expect(result.message).toContain('Add cart tests');
    expect(result.message).toContain('1 of 2');
  });
});

describe('childAuthority', () => {
  const parent: Authority = { tools: ['git'], spawn_children: true, max_child_count: 5, budget_usd: 25 };

  it('splits the agent allowance among the children rather than decrementing it', () => {
    // The bug: max_child_count fell by one per generation, which bounds depth
    // and nothing else. A root allowed 5 produced 57 agents.
    const child = childAuthority(parent, 5);
    // Five children consume all five of the allowance; none is left to go deeper.
    expect(child.max_child_count).toBe(0);
    expect(child.spawn_children).toBe(false);
  });

  it('leaves the remainder to be split when fewer children are created', () => {
    // 5 allowed, 2 created, 3 left, split two ways -> 1 each (floor).
    const child = childAuthority(parent, 2);
    expect(child.max_child_count).toBe(1);
    expect(child.spawn_children).toBe(true);
  });

  it('gives each child a share of its parent`s budget, not a flat amount', () => {
    // The bug: every child got $1 no matter what the parent held.
    // 2 children -> 3 shares of $25: one each, one kept for the parent's own
    // planning and synthesis runs.
    expect(childAuthority(parent, 2).budget_usd).toBeCloseTo(25 / 3);
    expect(childAuthority(parent, 4).budget_usd).toBeCloseTo(5);
  });

  it('can never produce an organization larger than the allowance', () => {
    // The property that matters, checked by construction rather than asserted.
    const size = (authority: Authority): number => {
      if (!authority.spawn_children || authority.max_child_count < 1) return 1;
      // The worst case is whichever split grows the tree most.
      let worst = 1;
      for (let k = 1; k <= authority.max_child_count; k++) {
        worst = Math.max(worst, 1 + k * size(childAuthority(authority, k)));
      }
      return worst;
    };
    for (const allowance of [0, 1, 2, 3, 5, 8]) {
      const root = { ...parent, max_child_count: allowance, budget_usd: 1000 };
      expect(size(root)).toBeLessThanOrEqual(allowance + 1);
    }
  });

  it('can never spend more than the root was authorized', () => {
    const spend = (authority: Authority): number => {
      if (!authority.spawn_children || authority.max_child_count < 1) return authority.budget_usd;
      let worst = authority.budget_usd;
      for (let k = 1; k <= authority.max_child_count; k++) {
        const child = childAuthority(authority, k);
        // The parent's own share plus everything its children may spend.
        worst = Math.max(worst, authority.budget_usd / (k + 1) + k * spend(child));
      }
      return worst;
    };
    expect(spend(parent)).toBeLessThanOrEqual(parent.budget_usd + 1e-9);
  });

  it('withholds spawn authority the child could never afford to use', () => {
    // Below two shares of the floor a child could only ESCALATE, asking a human
    // to approve the same delegation one generation down.
    const poor = childAuthority({ ...parent, budget_usd: 1 }, 2);
    expect(poor.spawn_children).toBe(false);
  });

  it('lets a human approval lift the child budget above its share', () => {
    expect(childAuthority({ ...parent, budget_usd: 0.5 }, 1, 4).budget_usd).toBe(4);
  });

  it('never widens tools beyond the parent', () => {
    expect(childAuthority({ ...parent, tools: ['git'] }, 2).tools).toEqual(['git']);
  });

  it('treats a nonsense sibling count as one child rather than dividing by zero', () => {
    expect(Number.isFinite(childAuthority(parent, 0).budget_usd)).toBe(true);
    expect(childAuthority(parent, 0).budget_usd).toBeCloseTo(12.5);
  });
});
