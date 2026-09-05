import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../db/client.js';
import { getNode, insertNode } from '../db/queries/nodes.js';
import { listEventsForNode } from '../db/queries/events.js';
import { startNodeActor, sendToNode } from './node-actor-manager.js';

const TEST_DB = './test-actor.db';

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

// Deliberately an escalating contract: spawn-authorized, budget too small for a
// child, and a long enough goal to read as high complexity. Every other outcome
// would dispatch a real Kubernetes Job from what is meant to be a unit test.
const GOAL = 'a deliberately long goal string that reads as high complexity to the coordinator, '.repeat(3);
const CONTRACT = {
  goal: GOAL, definition_of_done: ['done'],
  authority: { tools: [], spawn_children: true, max_child_count: 2, budget_usd: 0.01 }, constraints: [],
};

describe('node-actor-manager', () => {
  it('persists state transitions and appends an event per transition', async () => {
    const db = createDb(TEST_DB);
    insertNode(db, { id: 'n1', parentId: null, goal: GOAL, contract: CONTRACT, state: 'CREATED', createdAt: 't0', updatedAt: 't0' });

    startNodeActor(db, 'n1', GOAL);
    // INTELLIGENCE_GATE and EXECUTION_DECISION both resolve themselves through
    // async invokes now, so the node walks all the way here with no event from
    // this test.
    await vi.waitFor(() => expect(getNode(db, 'n1')?.state).toBe('ESCALATE'));

    const recordedEvents = listEventsForNode(db, 'n1');
    expect(recordedEvents.length).toBeGreaterThanOrEqual(2);
    expect(recordedEvents.every((e) => e.type === 'state.transition')).toBe(true);
  });

  it('throws when sending to a node with no active actor', () => {
    expect(() => sendToNode('missing', { type: 'DOD_MET' })).toThrow();
  });
});
