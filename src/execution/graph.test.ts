import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../db/client.js';
import { insertNode } from '../db/queries/nodes.js';
import { appendEvent } from '../db/queries/events.js';
import { executionGraph, readyNodes, blockedNodes, reuseCandidates, graphSummary, isTerminal } from './graph.js';

const TEST_DB = './test-execution-graph.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

type Db = ReturnType<typeof createDb>;

const add = (db: Db, id: string, state: string, parentId: string | null = null, goal = id) =>
  insertNode(db, {
    id, parentId, goal, state, repoPath: null, createdAt: 't0', updatedAt: 't0',
    contract: {
      goal, definition_of_done: ['d'],
      authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 5 },
      constraints: [],
    },
  });

describe('deriving the work model from what the runtime already records', () => {
  it('maps every machine state to an execution state', () => {
    const db = createDb(TEST_DB);
    const cases: [string, string][] = [
      ['CREATED', 'pending'], ['ORIENT', 'ready'], ['SELF_EXECUTE', 'running'],
      ['DELEGATE', 'running'], ['WAIT_APPROVAL', 'blocked'], ['COMPLETE', 'completed'],
      ['FAILED', 'failed'], ['CANCELLED', 'cancelled'],
    ];
    cases.forEach(([machine], i) => add(db, `n${i}`, machine));
    const graph = executionGraph(db);
    cases.forEach(([machine, expected], i) => {
      expect(graph.find((n) => n.id === `n${i}`)!.state).toBe(expected);
      expect(graph.find((n) => n.id === `n${i}`)!.machineState).toBe(machine);
    });
  });

  it('treats an unknown machine state as pending rather than throwing', () => {
    // A state added to the machine later must not take the scheduler down.
    const db = createDb(TEST_DB);
    add(db, 'n1', 'SOME_FUTURE_STATE');
    expect(executionGraph(db)[0].state).toBe('pending');
  });

  it('distinguishes a node that reused an answer from one that did the work', () => {
    // Losing this makes a cache hit indistinguishable from work, which is the
    // one thing the efficiency plane exists to tell apart.
    const db = createDb(TEST_DB);
    add(db, 'worked', 'COMPLETE');
    add(db, 'reused', 'COMPLETE');
    appendEvent(db, {
      nodeId: 'reused', type: 'step.progress',
      payload: { message: 'This exact question was already answered against this commit — reusing that answer instead of running again' },
      createdAt: 't1',
    });

    const graph = executionGraph(db);
    expect(graph.find((n) => n.id === 'worked')!.state).toBe('completed');
    expect(graph.find((n) => n.id === 'reused')!.state).toBe('reused');
    expect(graph.find((n) => n.id === 'reused')!.reused).toBe(true);
  });

  it('treats a parent as depending on its children', () => {
    const db = createDb(TEST_DB);
    add(db, 'root', 'DELEGATE');
    add(db, 'child', 'SELF_EXECUTE', 'root');
    expect(executionGraph(db).find((n) => n.id === 'root')!.dependencies).toEqual(['child']);
  });
});

describe('what can run, and what cannot', () => {
  it('reports a node ready only when every dependency has settled', () => {
    const db = createDb(TEST_DB);
    add(db, 'root', 'EXECUTION_DECISION');
    add(db, 'child', 'SELF_EXECUTE', 'root');
    expect(readyNodes(executionGraph(db)).map((n) => n.id)).toEqual([]);
  });

  it('frees a parent once its children are terminal, however they ended', () => {
    const db = createDb(TEST_DB);
    add(db, 'root', 'EXECUTION_DECISION');
    add(db, 'ok', 'COMPLETE', 'root');
    add(db, 'bad', 'FAILED', 'root');
    expect(readyNodes(executionGraph(db)).map((n) => n.id)).toContain('root');
  });

  it('never reports a running, terminal or blocked node as ready', () => {
    const db = createDb(TEST_DB);
    for (const [id, state] of [['a', 'SELF_EXECUTE'], ['b', 'COMPLETE'], ['c', 'WAIT_APPROVAL'], ['d', 'CANCELLED']]) {
      add(db, id, state);
    }
    expect(readyNodes(executionGraph(db))).toEqual([]);
  });

  it('separates waiting on a person from waiting on an agent', () => {
    // The same fact to a scheduler, and about as different as two facts get to
    // whoever is on call.
    const db = createDb(TEST_DB);
    add(db, 'human', 'WAIT_APPROVAL');
    add(db, 'root', 'EXECUTION_DECISION');
    add(db, 'child', 'SELF_EXECUTE', 'root');

    const blocked = blockedNodes(executionGraph(db));
    expect(blocked.find((b) => b.node.id === 'human')!.reason).toMatch(/person/);
    expect(blocked.find((b) => b.node.id === 'root')!.reason).toMatch(/1 unfinished agent/);
  });
});

describe('reuse candidates', () => {
  it('offers finished work with the same goal, and nothing else', () => {
    const db = createDb(TEST_DB);
    add(db, 'done', 'COMPLETE', null, 'Review the README');
    add(db, 'running', 'SELF_EXECUTE', null, 'Review the README');
    add(db, 'other', 'COMPLETE', null, 'Something else');

    const candidates = reuseCandidates(executionGraph(db), '  review the readme  ');
    expect(candidates.map((n) => n.id)).toEqual(['done']);
  });

  it('says only what there is to consider, not whether it is valid', () => {
    // Validity is a dependency question, answered elsewhere. Conflating them
    // here would put a cache decision in a graph query.
    const db = createDb(TEST_DB);
    add(db, 'done', 'COMPLETE', null, 'g');
    expect(reuseCandidates(executionGraph(db), 'g')).toHaveLength(1);
  });
});

describe('summary', () => {
  it('counts by state and knows which states are final', () => {
    const db = createDb(TEST_DB);
    add(db, 'a', 'COMPLETE');
    add(db, 'b', 'SELF_EXECUTE');
    add(db, 'c', 'FAILED');
    expect(graphSummary(executionGraph(db))).toMatchObject({ completed: 1, running: 1, failed: 1 });
    expect(isTerminal('reused')).toBe(true);
    expect(isTerminal('running')).toBe(false);
  });
});
