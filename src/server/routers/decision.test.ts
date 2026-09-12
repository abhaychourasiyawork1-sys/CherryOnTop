import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { buildServer } from '../app.js';
import { createDb } from '../../db/client.js';
import { insertNode } from '../../db/queries/nodes.js';
import { insertDecision } from '../../db/queries/decisions.js';

const TEST_DB = './test-decision-router.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

describe('decision router', () => {
  it('lists decisions for a node id', async () => {
    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({ nodeId: 'does-not-exist' }));
    const response = await app.inject({ method: 'GET', url: `/trpc/decision.listForNode?input=${input}` });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result.data).toEqual([]);
  });

  it('replays a node\'s recorded decisions through the same arithmetic', async () => {
    // The auditability claim, exercised end to end rather than asserted: the
    // decision was a formula, the formula's inputs were written down, and the
    // daemon can re-run them on request without a model call or a sandbox.
    const db = createDb(TEST_DB);
    const contract = {
      goal: 'g', definition_of_done: ['d'],
      authority: { tools: [], spawn_children: true, max_child_count: 2, budget_usd: 5 },
      constraints: [],
    };
    insertNode(db, { id: 'n1', parentId: null, goal: 'g', contract, state: 'COMPLETE', repoPath: null, createdAt: 't0', updatedAt: 't0' });
    insertDecision(db, {
      id: 'd1', nodeId: 'n1', type: 'execution_decision', outcome: 'DELEGATE',
      breakdown: {
        estimatedValue: 0.7, modelCost: 0.1, latencyCost: 0.05,
        coordinationCost: 0.15, verificationCost: 0.1, riskPenalty: 0,
        threshold: 0.3, score: 0.29999999999999993,
      },
      createdAt: new Date().toISOString(),
    });

    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({ nodeId: 'n1' }));
    const response = await app.inject({ method: 'GET', url: `/trpc/decision.replay?input=${input}` });
    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body).result.data;
    expect(data.allReproduced).toBe(true);
    expect(data.reproduced).toBe(1);
    expect(data.diverged).toEqual([]);
  });
});
