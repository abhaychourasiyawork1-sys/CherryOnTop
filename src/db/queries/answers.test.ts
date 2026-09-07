import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { appendEvent } from './events.js';
import { answerOf } from './answers.js';

const TEST_DB = './test-answers.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

describe('answerOf', () => {
  it('uses the combined answer a delegating node published', () => {
    // The case that was silently losing work: a node that only delegated has no
    // exec.result at all, so reading that alone reported it as having said
    // nothing to its own parent.
    const db = createDb(TEST_DB);
    appendEvent(db, { nodeId: 'n1', type: 'node.answer', payload: { text: 'Combined report' }, createdAt: 't1' });
    expect(answerOf(db, 'n1')).toBe('Combined report');
  });

  it('falls back to the final report of a node that did the work itself', () => {
    const db = createDb(TEST_DB);
    appendEvent(db, { nodeId: 'n1', type: 'exec.result', payload: { result: 'My findings' }, createdAt: 't1' });
    expect(answerOf(db, 'n1')).toBe('My findings');
  });

  it('prefers the combined answer over the raw report', () => {
    const db = createDb(TEST_DB);
    appendEvent(db, { nodeId: 'n1', type: 'exec.result', payload: { result: 'raw' }, createdAt: 't1' });
    appendEvent(db, { nodeId: 'n1', type: 'node.answer', payload: { text: 'combined' }, createdAt: 't2' });
    expect(answerOf(db, 'n1')).toBe('combined');
  });

  it('takes the last report when a node executed more than once', () => {
    const db = createDb(TEST_DB);
    appendEvent(db, { nodeId: 'n1', type: 'exec.result', payload: { result: 'first attempt' }, createdAt: 't1' });
    appendEvent(db, { nodeId: 'n1', type: 'exec.result', payload: { result: 'second attempt' }, createdAt: 't2' });
    expect(answerOf(db, 'n1')).toBe('second attempt');
  });

  it('ignores blank and non-string payloads', () => {
    const db = createDb(TEST_DB);
    appendEvent(db, { nodeId: 'n1', type: 'node.answer', payload: { text: '   ' }, createdAt: 't1' });
    appendEvent(db, { nodeId: 'n1', type: 'exec.result', payload: { result: 42 }, createdAt: 't2' });
    expect(answerOf(db, 'n1')).toBe('');
  });

  it('returns nothing for a node that has said nothing, and never leaks another node’s', () => {
    const db = createDb(TEST_DB);
    appendEvent(db, { nodeId: 'other', type: 'node.answer', payload: { text: 'not mine' }, createdAt: 't1' });
    expect(answerOf(db, 'n1')).toBe('');
  });
});
