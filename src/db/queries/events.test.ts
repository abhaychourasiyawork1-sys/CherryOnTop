import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { appendEvent, listEventsForNode, listRecentEvents } from './events.js';

const TEST_DB = './test-events.db';

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

describe('event queries', () => {
  it('appends and lists events for a node', () => {
    const db = createDb(TEST_DB);
    appendEvent(db, { nodeId: 'n1', type: 'state.transition', payload: { state: 'CREATED' }, createdAt: 't0' });
    appendEvent(db, { nodeId: 'n1', type: 'state.transition', payload: { state: 'ORIENT' }, createdAt: 't1' });
    appendEvent(db, { nodeId: 'n2', type: 'state.transition', payload: { state: 'CREATED' }, createdAt: 't0' });

    const events = listEventsForNode(db, 'n1');
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('state.transition');
  });

  it('returns the most recent events across all nodes, oldest-first, and pages backwards', () => {
    const db = createDb(TEST_DB);
    for (let i = 0; i < 10; i++) {
      appendEvent(db, { nodeId: i % 2 ? 'a' : 'b', type: 't', payload: { i }, createdAt: 't0' });
    }

    const page1 = listRecentEvents(db, { limit: 4 });
    expect(page1).toHaveLength(4);
    // Oldest-first within the page, so a transcript can replay it in order even
    // though the query itself selects the newest rows.
    expect(page1.map((e) => (e.payload as { i: number }).i)).toEqual([6, 7, 8, 9]);

    const page2 = listRecentEvents(db, { limit: 4, before: page1[0].id });
    expect(page2.map((e) => (e.payload as { i: number }).i)).toEqual([2, 3, 4, 5]);
  });

  it('returns everything when there are fewer events than the limit', () => {
    const db = createDb(TEST_DB);
    appendEvent(db, { nodeId: 'a', type: 't', payload: { i: 0 }, createdAt: 't0' });
    expect(listRecentEvents(db, { limit: 200 })).toHaveLength(1);
  });
});
