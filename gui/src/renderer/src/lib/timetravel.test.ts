import { describe, it, expect } from 'vitest';
import { projectTo, momentsOf } from './timetravel.js';
import type { OrgNode } from './useOrg.js';
import type { OrgEvent } from './eventLog.js';

const node = (id: string, parentId: string | null, createdAt: string): OrgNode => ({
  id, parentId, goal: id, state: 'CREATED',
  contract: {
    goal: id, definition_of_done: [id],
    authority: { tools: [], spawn_children: true, max_child_count: 2, budget_usd: 10 },
    constraints: [],
  },
  createdAt, updatedAt: createdAt, costUsd: 0, budgetHealth: 0, childCount: 0, needsApproval: false,
});

const NODES = [node('root', null, 't1'), node('kid', 'root', 't3')];

const EVENTS: OrgEvent[] = [
  { id: 1, nodeId: 'root', type: 'state.transition', payload: { state: 'PLAN' }, createdAt: 't2' },
  { id: 2, nodeId: 'root', type: 'state.transition', payload: { state: 'DELEGATE' }, createdAt: 't3' },
  { id: 3, nodeId: 'kid', type: 'exec.result', payload: { total_cost_usd: 2 }, createdAt: 't4' },
  { id: 4, nodeId: 'kid', type: 'state.transition', payload: { state: 'WAIT_APPROVAL' }, createdAt: 't5' },
  { id: 5, nodeId: 'kid', type: 'state.transition', payload: { state: 'COMPLETE' }, createdAt: 't6' },
];

describe('projecting the organization to a moment', () => {
  it('does not draw a node that did not exist yet', () => {
    expect(projectTo(NODES, EVENTS, 't2').nodes.map((n) => n.id)).toEqual(['root']);
    expect(projectTo(NODES, EVENTS, 't3').nodes.map((n) => n.id)).toEqual(['root', 'kid']);
  });

  it('replays the state each node held at that instant', () => {
    expect(projectTo(NODES, EVENTS, 't2').nodes[0].state).toBe('PLAN');
    expect(projectTo(NODES, EVENTS, 't3').nodes[0].state).toBe('DELEGATE');
  });

  it('rolls spend up to the parent, as the live view does', () => {
    const before = projectTo(NODES, EVENTS, 't3');
    expect(before.nodes.find((n) => n.id === 'root')!.costUsd).toBe(0);
    const after = projectTo(NODES, EVENTS, 't4');
    expect(after.nodes.find((n) => n.id === 'root')!.costUsd).toBe(2);
    expect(after.costUsd).toBe(2);
  });

  it('shows a node blocked on a human at the moment it was blocked, and not after', () => {
    expect(projectTo(NODES, EVENTS, 't5').awaitingNodeIds.has('kid')).toBe(true);
    expect(projectTo(NODES, EVENTS, 't6').awaitingNodeIds.has('kid')).toBe(false);
  });

  it('offers a stop only where something actually changed', () => {
    expect(momentsOf([
      ...EVENTS,
      { id: 6, nodeId: 'root', type: 'exec.assistant', payload: {}, createdAt: 't99' },
    ])).toEqual(['t2', 't3', 't4', 't5', 't6']);
  });
});
