import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { insertDecision, listDecisionsForNode } from './decisions.js';
import type { Decision } from '../../schemas/decision.js';

const TEST_DB = './test-decisions.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const BASE: Decision = {
  id: 'd1', nodeId: 'n1', type: 'execution_decision', outcome: 'SELF_EXECUTE',
  breakdown: { score: 0.1 }, createdAt: 't0',
};

describe('decision queries', () => {
  it('inserts and lists decisions for a node', () => {
    const db = createDb(TEST_DB);
    insertDecision(db, BASE);
    insertDecision(db, { ...BASE, id: 'd2' });
    insertDecision(db, { ...BASE, id: 'd3', nodeId: 'n2' });
    const list = listDecisionsForNode(db, 'n1');
    expect(list).toHaveLength(2);
    expect(list[0].outcome).toBe('SELF_EXECUTE');
  });
});
