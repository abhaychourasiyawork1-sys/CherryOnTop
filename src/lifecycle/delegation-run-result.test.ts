import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb, type Db } from '../db/client.js';
import { insertNode } from '../db/queries/nodes.js';
import { appendEvent } from '../db/queries/events.js';
import { childRunResult } from './node-actor-manager.js';
import { openDelegation, transitionDelegation } from './delegation-events.js';

const TEST_DB = './test-delegation-run-result.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const contract = (goal: string) => ({
  goal, definition_of_done: ['done'],
  authority: { tools: [] as string[], spawn_children: false, max_child_count: 0, budget_usd: 1 }, constraints: [] as string[],
});

function setup(): Db {
  const db = createDb(TEST_DB);
  insertNode(db, { id: 'p', parentId: null, goal: 'p', contract: contract('p'), state: 'DELEGATE', createdAt: 't', updatedAt: 't' });
  insertNode(db, { id: 'c', parentId: 'p', goal: 'c', contract: contract('c'), state: 'COMPLETE', createdAt: 't', updatedAt: 't' });
  return db;
}

let clock = 0;
const exec = (db: Db, type: 'assistant' | 'user', payload: unknown) =>
  appendEvent(db, { nodeId: 'c', type: `exec.${type}`, payload, createdAt: `t${++clock}` });

/** One `npm test` run by the child, green or red. */
function runTests(db: Db, id: string, passed: boolean) {
  exec(db, 'assistant', { message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }] } });
  exec(db, 'user', { message: { content: [{ type: 'tool_result', tool_use_id: id, content: passed ? 'ok' : 'FAIL 2 tests', is_error: !passed }] } });
}

/** The parent sending this child back for another revision. */
function startRework(db: Db) {
  openDelegationOnce(db);
  transitionDelegation(db, 'a', 'WORKING', {}, 't');
  transitionDelegation(db, 'a', 'REPORT_READY', {}, 't');
  transitionDelegation(db, 'a', 'UNDER_REVIEW', {}, 't');
  transitionDelegation(db, 'a', 'FEEDBACK_REQUIRED', {}, 't');
  transitionDelegation(db, 'a', 'REWORKING', { attempt: 2 }, 't');
}
function openDelegationOnce(db: Db) {
  openDelegation(db, { id: 'a', parentId: 'p', childId: 'c', goal: 'c', definitionOfDone: ['d'], acceptanceChecks: ['npm test'], dependencies: [], budgetUsd: 1 }, 't');
}

describe('childRunResult judges the current revision, not the whole history', () => {
  it('a check that failed in the last revision and passed in this one is passing', () => {
    const db = setup();
    runTests(db, 't1', false); // revision 1: red — what the parent refused
    startRework(db);
    runTests(db, 't2', true); // revision 2: fixed and re-run green

    const result = childRunResult(db, 'c', { succeeded: true });
    expect(result.observedChecks).toEqual([expect.objectContaining({ command: 'npm test', passed: true })]);
  });

  it('a check that passed in an earlier revision is not evidence for this one', () => {
    // The parent asked for the work again; a green run from before the change
    // says nothing about the tree as it stands now.
    const db = setup();
    runTests(db, 't1', true);
    startRework(db);

    expect(childRunResult(db, 'c', { succeeded: true }).observedChecks).toEqual([]);
  });

  it('a first run with no rework reads its whole history', () => {
    const db = setup();
    runTests(db, 't1', true);
    expect(childRunResult(db, 'c', { succeeded: true }).observedChecks).toEqual([expect.objectContaining({ passed: true })]);
  });

  it('a cancelled child reports nothing else', () => {
    const db = setup();
    expect(childRunResult(db, 'c', { succeeded: false, cancelled: true })).toEqual({ succeeded: false, cancelled: true });
  });
});
