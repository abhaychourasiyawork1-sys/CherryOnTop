import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { createDb } from '../client.js';
import { appendEvent, verifyChain, listEventsForNode } from './events.js';

const TEST_DB = './test-chain.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

describe('the event log is tamper-evident', () => {
  it('verifies a log nobody has touched', () => {
    const db = createDb(TEST_DB);
    for (let i = 0; i < 5; i++) {
      appendEvent(db, { nodeId: 'n1', type: 'step.progress', payload: { message: `m${i}` }, createdAt: `t${i}` });
    }
    expect(verifyChain(db)).toEqual({ ok: true, checked: 5, unchained: 0 });
  });

  it('names the exact row whose content was edited after the fact', () => {
    const db = createDb(TEST_DB);
    for (let i = 0; i < 4; i++) {
      appendEvent(db, { nodeId: 'n1', type: 'step.progress', payload: { message: `m${i}` }, createdAt: `t${i}` });
    }
    // The realistic attack: quietly rewrite one payload and leave everything else.
    db.run(sql`UPDATE events SET payload = '{"message":"tampered"}' WHERE id = 2`);

    const verdict = verifyChain(db);
    expect(verdict.ok).toBe(false);
    expect(verdict.brokenAtId).toBe(2);
  });

  it('catches a row deleted from the middle', () => {
    const db = createDb(TEST_DB);
    for (let i = 0; i < 4; i++) {
      appendEvent(db, { nodeId: 'n1', type: 'x', payload: { i }, createdAt: `t${i}` });
    }
    db.run(sql`DELETE FROM events WHERE id = 2`);
    expect(verifyChain(db).ok).toBe(false);
  });

  it('treats rows from before chaining as old, not as tampering', () => {
    const db = createDb(TEST_DB);
    db.run(sql`INSERT INTO events (node_id, type, payload, created_at) VALUES ('n1','legacy','{}','t0')`);
    appendEvent(db, { nodeId: 'n1', type: 'new', payload: {}, createdAt: 't1' });
    const verdict = verifyChain(db);
    expect(verdict.ok).toBe(true);
    expect(verdict.unchained).toBe(1);
    expect(verdict.checked).toBe(1);
  });

  it('does not change what readers already get back', () => {
    const db = createDb(TEST_DB);
    appendEvent(db, { nodeId: 'n1', type: 'step.progress', payload: { message: 'hello' }, createdAt: 't0' });
    const [row] = listEventsForNode(db, 'n1');
    expect(row.payload).toEqual({ message: 'hello' });
  });
});
