import { describe, it, expect } from 'vitest';
import { toTasks, subtreeIds, subtreeOf, depths } from './tasks.js';
import type { OrgNode } from './useOrg.js';

function node(over: Partial<OrgNode> & { id: string }): OrgNode {
  return {
    parentId: null,
    goal: over.id,
    state: 'SELF_EXECUTE',
    contract: {
      goal: over.id,
      definition_of_done: ['done'],
      authority: { tools: [], spawn_children: true, max_child_count: 3, budget_usd: 5 },
      constraints: [],
    },
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
    costUsd: 0,
    budgetHealth: 0,
    childCount: 0,
    needsApproval: false,
    ...over,
  };
}

const TREE = [
  node({ id: 'root', createdAt: '2026-09-06T10:00:00.000Z' }),
  node({ id: 'a', parentId: 'root' }),
  node({ id: 'b', parentId: 'root' }),
  node({ id: 'a1', parentId: 'a' }),
  node({ id: 'other', createdAt: '2026-09-06T12:00:00.000Z' }),
];

describe('subtreeIds', () => {
  it('collects a root and everything delegated beneath it', () => {
    expect(subtreeIds(TREE, 'root').sort()).toEqual(['a', 'a1', 'b', 'root']);
  });

  it('scopes to a branch, not the whole tree', () => {
    expect(subtreeIds(TREE, 'a').sort()).toEqual(['a', 'a1']);
  });

  it('does not loop on a cycle', () => {
    const cyclic = [node({ id: 'x', parentId: 'y' }), node({ id: 'y', parentId: 'x' })];
    expect(subtreeIds(cyclic, 'x').sort()).toEqual(['x', 'y']);
  });

  it('returns just the node when it has no children', () => {
    expect(subtreeIds(TREE, 'a1')).toEqual(['a1']);
  });
});

describe('subtreeOf', () => {
  it('keeps input order so the graph layout stays stable', () => {
    expect(subtreeOf(TREE, 'root').map((n) => n.id)).toEqual(['root', 'a', 'b', 'a1']);
  });

  it('excludes unrelated roots', () => {
    expect(subtreeOf(TREE, 'root').map((n) => n.id)).not.toContain('other');
  });
});

describe('depths', () => {
  it('measures how far each node sits below its root', () => {
    const depth = depths(TREE);
    expect(depth.get('root')).toBe(0);
    expect(depth.get('a')).toBe(1);
    expect(depth.get('a1')).toBe(2);
    expect(depth.get('other')).toBe(0);
  });

  it('treats a node whose parent is not loaded as a root', () => {
    expect(depths([node({ id: 'orphan', parentId: 'missing' })]).get('orphan')).toBe(0);
  });

  it('terminates on a cycle instead of recursing forever', () => {
    const cyclic = [node({ id: 'x', parentId: 'y' }), node({ id: 'y', parentId: 'x' })];
    expect(() => depths(cyclic)).not.toThrow();
  });
});

describe('toTasks', () => {
  it('lists only roots, newest first', () => {
    expect(toTasks(TREE).map((t) => t.id)).toEqual(['other', 'root']);
  });

  it('counts the whole subtree, not just the root', () => {
    expect(toTasks(TREE).find((t) => t.id === 'root')!.nodeCount).toBe(4);
    expect(toTasks(TREE).find((t) => t.id === 'other')!.nodeCount).toBe(1);
  });

  it('flags a task whose deepest child is waiting on a human', () => {
    const waiting = TREE.map((n) => (n.id === 'a1' ? { ...n, needsApproval: true } : n));
    const task = toTasks(waiting).find((t) => t.id === 'root')!;
    expect(task.needsApproval).toBe(true);
    // The whole task takes on the waiting colour — the rail is where you notice.
    expect(task.tone).toBe('at-risk');
  });

  it('reports a finished task as not running', () => {
    const done = TREE.map((n) => (n.id === 'root' ? { ...n, state: 'COMPLETE' } : n));
    const task = toTasks(done).find((t) => t.id === 'root')!;
    expect(task.running).toBe(false);
    expect(task.tone).toBe('settled');
  });

  it('handles an organization with nothing in it', () => {
    expect(toTasks([])).toEqual([]);
  });
});
