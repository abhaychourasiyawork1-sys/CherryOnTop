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

// Deliberately an escalating contract: spawn-authorized, budget too small to
// fund a child, and a goal that genuinely reads as several pieces of work.
// Every other outcome would dispatch a real Kubernetes Job from what is meant
// to be a unit test.
//
// The goal used to be one long sentence repeated three times, back when
// complexity was measured in characters. It now has to actually look
// decomposable — breadth across many things, and more than one kind of work —
// because that is what the coordinator reads (see intelligence/decompose.ts).
const GOAL = 'Review every module across the entire codebase for bugs, and also add tests for each service';
const CONTRACT = {
  goal: GOAL, definition_of_done: ['done'],
  authority: { tools: [], spawn_children: true, max_child_count: 2, budget_usd: 0.01 }, constraints: [],
};

describe('node-actor-manager', () => {
  it('persists state transitions and appends an event per transition, plus the decision it made', async () => {
    const db = createDb(TEST_DB);
    insertNode(db, { id: 'n1', parentId: null, goal: GOAL, contract: CONTRACT, state: 'CREATED', createdAt: 't0', updatedAt: 't0' });

    startNodeActor(db, 'n1', GOAL);
    // INTELLIGENCE_GATE and EXECUTION_DECISION both resolve themselves through
    // async invokes now, so the node walks all the way here with no event from
    // this test.
    await vi.waitFor(() => expect(getNode(db, 'n1')?.state).toBe('WAIT_APPROVAL'));

    const recordedEvents = listEventsForNode(db, 'n1');
    expect(recordedEvents.length).toBeGreaterThanOrEqual(2);
    expect(recordedEvents.filter((e) => e.type === 'state.transition').length).toBeGreaterThanOrEqual(2);

    // The decision is logged as an event too, so a live transcript can narrate
    // why the node escalated instead of only that it did.
    const decision = recordedEvents.find((e) => e.type === 'decision.made');
    expect(decision).toBeDefined();
    expect((decision!.payload as { outcome: string }).outcome).toBe('ESCALATE');
  });

  it('throws when sending to a node with no active actor', () => {
    expect(() => sendToNode('missing', { type: 'APPROVED' })).toThrow();
  });
});
