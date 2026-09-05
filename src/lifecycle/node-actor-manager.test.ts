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

const CONTRACT = {
  goal: 'test', definition_of_done: ['done'],
  authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 0 }, constraints: [],
};

describe('node-actor-manager', () => {
  it('persists state transitions and appends an event per transition', async () => {
    const db = createDb(TEST_DB);
    insertNode(db, { id: 'n1', parentId: null, goal: 'test', contract: CONTRACT, state: 'CREATED', createdAt: 't0', updatedAt: 't0' });

    startNodeActor(db, 'n1', 'test');
    // INTELLIGENCE_GATE resolves itself through an async invoke now, so the node
    // walks to EXECUTION_DECISION with no event from this test.
    await vi.waitFor(() => expect(getNode(db, 'n1')?.state).toBe('EXECUTION_DECISION'));

    const recordedEvents = listEventsForNode(db, 'n1');
    expect(recordedEvents.length).toBeGreaterThanOrEqual(2);
    expect(recordedEvents.every((e) => e.type === 'state.transition')).toBe(true);
  });

  it('throws when sending to a node with no active actor', () => {
    expect(() => sendToNode('missing', { type: 'DOD_MET' })).toThrow();
  });
});
