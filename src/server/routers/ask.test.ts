import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { buildServer } from '../app.js';
import { createDb } from '../../db/client.js';
import { insertNode } from '../../db/queries/nodes.js';
import { insertDecision } from '../../db/queries/decisions.js';
import { insertApproval } from '../../db/queries/approvals.js';
import { insertArtifact } from '../../db/queries/artifacts.js';
import { appendEvent } from '../../db/queries/events.js';

// askRouter is mounted as `org` on the composed AppRouter (see root-router.ts):
// its endpoints are /trpc/org.ask, not /trpc/ask.ask.
const TEST_DB = './test-ask-router.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const contract = (budget = 5) => ({
  goal: 'ship the thing', definition_of_done: ['d'],
  authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: budget },
  constraints: [],
});

async function ask(app: ReturnType<typeof buildServer>, question: string, focusedNodeId?: string) {
  const input = encodeURIComponent(JSON.stringify({ question, focusedNodeId }));
  const response = await app.inject({ method: 'GET', url: `/trpc/org.ask?input=${input}` });
  return { status: response.statusCode, data: JSON.parse(response.body).result?.data };
}

describe('ask router — why', () => {
  it('explains a focused node from its recorded decisions', async () => {
    const db = createDb(TEST_DB);
    insertNode(db, { id: 'n1', parentId: null, goal: 'g', contract: contract(), state: 'COMPLETE', repoPath: null, createdAt: 't0', updatedAt: 't0' });
    insertDecision(db, { id: 'd1', nodeId: 'n1', type: 'execution_decision', outcome: 'DELEGATE', breakdown: { score: 0.5 }, createdAt: 't0' });

    const app = buildServer(TEST_DB, () => {});
    const { status, data } = await ask(app, 'why did it do that', 'n1');
    expect(status).toBe(200);
    expect(data.intent).toBe('why');
    expect(data.decisions).toHaveLength(1);
  });

  it('asks the caller to focus a node first when none is identified', async () => {
    const app = buildServer(TEST_DB, () => {});
    const { data } = await ask(app, 'why?');
    expect(data.intent).toBe('why');
    expect(data.decisions).toEqual([]);
    expect(data.answer).toContain('Select a node first');
  });
});

describe('ask router — blocking', () => {
  it('reports a pending approval as what is blocking', async () => {
    const db = createDb(TEST_DB);
    insertNode(db, { id: 'n1', parentId: null, goal: 'g', contract: contract(), state: 'COMPLETE', repoPath: null, createdAt: 't0', updatedAt: 't0' });
    insertApproval(db, { id: 'a1', nodeId: 'n1', reason: 'r', status: 'pending', createdAt: 't0' });

    const app = buildServer(TEST_DB, () => {});
    const { data } = await ask(app, 'what is blocking?');
    expect(data.intent).toBe('blocking');
    expect(data.blockedBy).toBe('approval');
    expect(data.approvals).toHaveLength(1);
  });

  it('reports nothing is blocked when everything is terminal and nothing is pending', async () => {
    const db = createDb(TEST_DB);
    insertNode(db, { id: 'n1', parentId: null, goal: 'g', contract: contract(), state: 'COMPLETE', repoPath: null, createdAt: 't0', updatedAt: 't0' });

    const app = buildServer(TEST_DB, () => {});
    const { data } = await ask(app, 'what is blocking?');
    expect(data.blockedBy).toBe('nothing');
    expect(data.nodes).toEqual([]);
  });
});

describe('ask router — cost', () => {
  it('reports cost for a focused node against its budget', async () => {
    const db = createDb(TEST_DB);
    insertNode(db, { id: 'n1', parentId: null, goal: 'g', contract: contract(10), state: 'COMPLETE', repoPath: null, createdAt: 't0', updatedAt: 't0' });
    appendEvent(db, { nodeId: 'n1', type: 'exec.result', payload: { total_cost_usd: 2.5 }, createdAt: 't0' });

    const app = buildServer(TEST_DB, () => {});
    const { data } = await ask(app, 'what did this cost', 'n1');
    expect(data.intent).toBe('cost');
    expect(data.costUsd).toBe(2.5);
    expect(data.budgetUsd).toBe(10);
  });

  it('reports the org-wide total when no node is focused', async () => {
    const app = buildServer(TEST_DB, () => {});
    const { data } = await ask(app, 'how much money has been spent');
    expect(data.intent).toBe('cost');
    expect(data.costUsd).toBe(0);
  });
});

describe('ask router — evidence', () => {
  it('lists the artifacts a focused node produced', async () => {
    const db = createDb(TEST_DB);
    insertNode(db, { id: 'n1', parentId: null, goal: 'g', contract: contract(), state: 'COMPLETE', repoPath: null, createdAt: 't0', updatedAt: 't0' });
    insertArtifact(db, { id: 'art1', nodeId: 'n1', kind: 'file', path: null, summary: 's', createdAt: 't0' });

    const app = buildServer(TEST_DB, () => {});
    const { data } = await ask(app, 'what evidence did it produce', 'n1');
    expect(data.intent).toBe('evidence');
    expect(data.artifacts).toHaveLength(1);
  });
});

describe('ask router — unknown', () => {
  it('lists what it can answer when the question matches no known intent', async () => {
    const app = buildServer(TEST_DB, () => {});
    const { data } = await ask(app, 'what is the meaning of life');
    expect(data.intent).toBe('unknown');
    expect(data.supported.length).toBeGreaterThan(0);
  });
});

describe('ask router — invalid input', () => {
  it('rejects a request missing the required question via the Zod validation path, not a 500', async () => {
    const app = buildServer(TEST_DB, () => {});
    const input = encodeURIComponent(JSON.stringify({}));
    const response = await app.inject({ method: 'GET', url: `/trpc/org.ask?input=${input}` });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.data.code).toBe('BAD_REQUEST');
  });
});
