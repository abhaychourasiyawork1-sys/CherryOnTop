import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { appendEvent, listEventsForNode } from './events.js';

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
});
