import { describe, it, expect } from 'vitest';
import { chainOf, narrowing } from './custody.js';

const auth = (over: Record<string, unknown> = {}) => ({
  tools: ['Read', 'Write', 'Bash'], spawn_children: true, max_child_count: 3, budget_usd: 10, ...over,
}) as never;

const node = (id: string, parentId: string | null, over: Record<string, unknown> = {}) => ({
  id, parentId, goal: `goal ${id}`, contract: { authority: auth(over) },
});

describe('chain of custody', () => {
  it('starts at the person, never at an agent', () => {
    expect(chainOf([node('root', null)], 'root').origin).toBe('human');
  });

  it('walks every hand the authority passed through, root first', () => {
    const nodes = [node('root', null), node('mid', 'root'), node('leaf', 'mid')];
    expect(chainOf(nodes, 'leaf').hops.map((h) => h.nodeId)).toEqual(['root', 'mid', 'leaf']);
  });

  it('does not call a smaller budget a narrowing — every child gets one', () => {
    expect(narrowing(auth(), auth({ budget_usd: 1 }))).toEqual([]);
  });

  it('names authority a child was actually refused', () => {
    expect(narrowing(auth(), auth({ spawn_children: false }))).toContain('may no longer delegate');
    expect(narrowing(auth(), auth({ tools: ['Read'] }))).toContain('lost Write, Bash');
  });

  it('reports a shallower delegation depth without calling it a full loss', () => {
    expect(narrowing(auth({ max_child_count: 3 }), auth({ max_child_count: 1 })))
      .toEqual(['may build 1 agents, not 3']);
  });

  it('leaves the root unnarrowed — nothing above it took anything away', () => {
    const nodes = [node('root', null), node('leaf', 'root', { tools: ['Read'] })];
    const chain = chainOf(nodes, 'leaf');
    expect(chain.hops[0].narrowed).toEqual([]);
    expect(chain.hops[1].narrowed).toEqual(['lost Write, Bash']);
  });

  it('survives a broken parent link instead of looping for ever', () => {
    const chain = chainOf([node('orphan', 'missing')], 'orphan');
    expect(chain.hops.map((h) => h.nodeId)).toEqual(['orphan']);
  });
});
