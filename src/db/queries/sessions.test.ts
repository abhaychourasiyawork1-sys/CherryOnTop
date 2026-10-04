import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { appendEvent } from './events.js';
import { insertNode } from './nodes.js';
import { insertSession, sessionMemoryFor, deleteSession, sessionRuns, renderSessionMemory, type SessionTurn } from './sessions.js';

const TEST_DB = './test-sessions.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
});

const contract = (goal: string) => ({ goal, definition_of_done: [goal], authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 1 }, constraints: [] });
const turn = (n: number, answer = `answer ${n}`): SessionTurn => ({ nodeId: `n${n}`, request: `request ${n}`, state: 'COMPLETE', answer, files: [] });

describe('session memory', () => {
  it('hands a follow-up the earlier requests and answers, not later ones', () => {
    const db = createDb(TEST_DB);
    insertSession(db, { id: 's', repoPath: '/w', title: 't', createdAt: 't0', updatedAt: 't0' });
    for (const [id, at] of [['a', 't1'], ['b', 't2'], ['c', 't3']]) {
      insertNode(db, { id, parentId: null, goal: `goal ${id}`, contract: contract(`goal ${id}`), state: 'COMPLETE', sessionId: 's', createdAt: at, updatedAt: at });
    }
    appendEvent(db, { nodeId: 'a', type: 'exec.result', payload: { result: 'Added the cache.' }, createdAt: 't1' });
    const memory = sessionMemoryFor(db, 's', 'b');
    expect(memory).toContain('goal a');
    expect(memory).toContain('Added the cache.');
    expect(memory).not.toContain('goal b');
    expect(sessionMemoryFor(db, 's', 'a')).toBe('');
  });

  it('keeps the first and latest turns verbatim and condenses the middle', () => {
    const memory = renderSessionMemory([1, 2, 3, 4, 5, 6, 7].map((n) => turn(n)));
    expect(memory).toContain('answer 1');
    expect(memory).not.toContain('answer 2');
    expect(memory).toContain('- Turn 2 (done): request 2');
    expect(memory).toContain('answer 7');
  });

  it('stays within budget, keeping the newest answer longest', () => {
    const big = 'x'.repeat(3000);
    const memory = renderSessionMemory([1, 2, 3, 4, 5].map((n) => turn(n, `${n}${big}`)), { recentTurns: 4, answerChars: 4000, totalChars: 5000 });
    expect(memory.length).toBeLessThan(5600);
    expect(memory).toContain(`5${big}`);
  });

  it('deleting a session keeps its runs on record', () => {
    const db = createDb(TEST_DB);
    insertSession(db, { id: 's', repoPath: '/w', title: 't', createdAt: 't0', updatedAt: 't0' });
    insertNode(db, { id: 'a', parentId: null, goal: 'g', contract: contract('g'), state: 'COMPLETE', sessionId: 's', createdAt: 't1', updatedAt: 't1' });
    deleteSession(db, 's');
    expect(sessionRuns(db, 's')).toEqual([]);
  });
});

describe('a long session keeps what a follow-up depends on', () => {
  const long = (n: number) => Array.from({ length: n }, (_, i) => turn(i + 1, `answer ${i + 1} ${'y'.repeat(2_000)}`));
  const firstRequest = 'request 1';

  it.each([
    ['the default budget', undefined],
    ['a tight one', { recentTurns: 2, answerChars: 1500, totalChars: 8000 }],
    ['the tightest rung', { recentTurns: 1, answerChars: 400, totalChars: 2000 }],
  ])('with %s and 300 turns, still has the first turn and the newest, and stays bounded', (_name, budget) => {
    const memory = renderSessionMemory(long(300), budget);
    const limit = (budget?.totalChars ?? 24_000) + 1_000; // the header and footer around the body
    expect(memory.length).toBeLessThan(limit);
    expect(memory).toContain(firstRequest);
    expect(memory).toContain('request 300');
    // The newest turn is the one "it" and "again" refer to: it survives as the
    // whole turn, not as a stub cut off by the clip.
    expect(memory).toContain('### Turn 300');
  });

  it('says how many turns it left out, rather than pretending there were none', () => {
    const memory = renderSessionMemory(long(300), { recentTurns: 1, answerChars: 400, totalChars: 2000 });
    expect(memory).toMatch(/\(\d+ earlier turns not listed here\)/);
  });

  it('is untouched when everything fits', () => {
    const memory = renderSessionMemory([1, 2, 3].map((n) => turn(n)));
    expect(memory).not.toContain('not listed here');
  });
});
