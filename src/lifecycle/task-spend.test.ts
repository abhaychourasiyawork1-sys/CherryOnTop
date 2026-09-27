/** The spend cap covers the whole task tree, not one agent. Measured before
 *  this: a delegating Terminal-Bench run spent $7.46 against a $5 cap, because
 *  each agent's guard counted only its own dispatches. */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../db/client.js';
import { getNode, insertNode } from '../db/queries/nodes.js';
import { appendEvent } from '../db/queries/events.js';
import { evaluateTaskSpend } from './node-actor-manager.js';

const TEST_DB = './test-task-spend.db';
afterEach(() => { for (const s of ['', '-wal', '-shm', '-journal']) if (existsSync(TEST_DB + s)) unlinkSync(TEST_DB + s); });

const node = (db: ReturnType<typeof createDb>, id: string, parentId: string | null, budget: number) => insertNode(db, {
  id, parentId, goal: 'g', state: 'SELF_EXECUTE', createdAt: 't', updatedAt: 't',
  contract: { goal: 'g', definition_of_done: ['d'], constraints: [], authority: { tools: [], spawn_children: true, max_child_count: 3, budget_usd: budget } },
});
let session = 0;
const spend = (db: ReturnType<typeof createDb>, nodeId: string, costUsd: number) =>
  appendEvent(db, { nodeId, type: 'exec.result', payload: { session_id: `s${++session}`, total_cost_usd: costUsd }, createdAt: 't' });

describe('the spend guard counts the task tree', () => {
  it('stops a parent whose children have already spent its budget', () => {
    const db = createDb(TEST_DB);
    node(db, 'root', null, 5);
    node(db, 'a', 'root', 1.67);
    node(db, 'b', 'root', 1.67);
    spend(db, 'a', 2.9);
    spend(db, 'b', 2.6);
    const guard = evaluateTaskSpend(db, 'root', getNode(db, 'root'));
    expect(guard.spentUsd).toBeCloseTo(5.5);
    expect(guard.state).toBe('STOP');
  });

  it('stops a child once the task is out of money, even with room in its own share', () => {
    const db = createDb(TEST_DB);
    node(db, 'root', null, 5);
    node(db, 'a', 'root', 3);
    node(db, 'b', 'root', 3);
    spend(db, 'root', 1);
    spend(db, 'b', 4.2);
    const guard = evaluateTaskSpend(db, 'a', getNode(db, 'a'));
    expect(guard.spendCapUsd).toBe(5);
    expect(guard.state).toBe('STOP');
  });

  it('leaves a child its own share while the task has room', () => {
    const db = createDb(TEST_DB);
    node(db, 'root', null, 5);
    node(db, 'a', 'root', 1.67);
    spend(db, 'a', 0.5);
    const guard = evaluateTaskSpend(db, 'a', getNode(db, 'a'));
    expect(guard.spendCapUsd).toBe(1.67);
    expect(guard.state).not.toBe('STOP');
  });
});
