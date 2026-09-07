import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { insertNode } from './nodes.js';
import { appendEvent } from './events.js';
import { insertApproval } from './approvals.js';
import { insertDodItems, setDodState } from './dod.js';
import { seedBuiltinMandates } from './mandates.js';
import { listCases, listAttention, caseFacets } from './cases.js';

const TEST_DB = './test-cases.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

type Db = ReturnType<typeof createDb>;

const contract = (over: Record<string, unknown> = {}) => ({
  goal: 'g', definition_of_done: ['d'],
  authority: { tools: [], spawn_children: true, max_child_count: 2, budget_usd: 5, ...over },
  constraints: [],
});

function node(db: Db, o: {
  id: string; parent?: string | null; goal?: string; state?: string;
  budget?: number; mandateId?: string | null; runtime?: string | null;
  repoPath?: string | null; createdAt?: string; updatedAt?: string;
}) {
  insertNode(db, {
    id: o.id, parentId: o.parent ?? null, goal: o.goal ?? o.id,
    contract: contract({ budget_usd: o.budget ?? 5 }) as never,
    state: o.state ?? 'COMPLETE', repoPath: o.repoPath ?? '/repo',
    runtime: o.runtime ?? 'claude-code', mandateId: o.mandateId ?? null, snapshot: null,
    createdAt: o.createdAt ?? '2026-09-01T00:00:00.000Z',
    updatedAt: o.updatedAt ?? '2026-09-01T00:05:00.000Z',
  });
}

function spend(db: Db, nodeId: string, usd: number) {
  appendEvent(db, { nodeId, type: 'exec.result', payload: { total_cost_usd: usd }, createdAt: 't' });
}

describe('listCases', () => {
  it('lists roots only, and rolls the whole organization up into each row', () => {
    const db = createDb(TEST_DB);
    node(db, { id: 'root', goal: 'ship it' });
    node(db, { id: 'kid1', parent: 'root' });
    node(db, { id: 'kid2', parent: 'root' });
    spend(db, 'kid1', 1.5);
    spend(db, 'kid2', 0.5);

    const cases = listCases(db);
    expect(cases).toHaveLength(1);
    expect(cases[0].id).toBe('root');
    expect(cases[0].agents).toBe(3);
    expect(cases[0].costUsd).toBeCloseTo(2);
  });

  it('newest first', () => {
    const db = createDb(TEST_DB);
    node(db, { id: 'old', createdAt: '2026-01-01T00:00:00.000Z' });
    node(db, { id: 'new', createdAt: '2026-09-01T00:00:00.000Z' });
    expect(listCases(db).map((c) => c.id)).toEqual(['new', 'old']);
  });

  it('separates waiting on a human from merely running', () => {
    const db = createDb(TEST_DB);
    node(db, { id: 'busy', state: 'SELF_EXECUTE' });
    node(db, { id: 'blocked', state: 'WAIT_APPROVAL' });
    insertApproval(db, { id: 'a1', nodeId: 'blocked', reason: 'r', status: 'pending', createdAt: 't' });

    const byId = new Map(listCases(db).map((c) => [c.id, c.outcome]));
    expect(byId.get('busy')).toBe('running');
    expect(byId.get('blocked')).toBe('waiting');
  });

  it('reports an interrupted case as its own outcome, not as a failure', () => {
    const db = createDb(TEST_DB);
    node(db, { id: 'parked', state: 'INTERRUPTED' });
    expect(listCases(db)[0].outcome).toBe('interrupted');
  });

  it('counts a case`s definition of done across every agent in it', () => {
    const db = createDb(TEST_DB);
    node(db, { id: 'root' });
    node(db, { id: 'kid', parent: 'root' });
    insertDodItems(db, 'root', ['a'], 't', () => 'i1');
    insertDodItems(db, 'kid', ['b'], 't', () => 'i2');
    setDodState(db, 'i1', 'met', {}, 't');

    expect(listCases(db)[0].dod).toEqual({ met: 1, unmet: 0, unverified: 1, total: 2 });
  });

  it('counts the times a person actually decided something', () => {
    const db = createDb(TEST_DB);
    node(db, { id: 'root' });
    insertApproval(db, { id: 'a1', nodeId: 'root', reason: 'r', status: 'approved', createdAt: 't' });
    insertApproval(db, { id: 'a2', nodeId: 'root', reason: 'r', status: 'cancelled', createdAt: 't' });
    // Cancelled is not a decision anyone made — it is what happens when a run
    // stops out from under an approval.
    expect(listCases(db)[0].humanDecisions).toBe(1);
  });

  it('counts tool calls the mandate refused', () => {
    const db = createDb(TEST_DB);
    node(db, { id: 'root' });
    node(db, { id: 'kid', parent: 'root' });
    appendEvent(db, { nodeId: 'kid', type: 'authority.denied', payload: { tool: 'Bash' }, createdAt: 't' });
    expect(listCases(db)[0].denials).toBe(1);
  });

  describe('filters', () => {
    const seeded = () => {
      const db = createDb(TEST_DB);
      seedBuiltinMandates(db, 't');
      node(db, { id: 'a', goal: 'refactor the parser', mandateId: 'builtin-investigate', runtime: 'codex' });
      node(db, { id: 'b', goal: 'write tests', state: 'FAILED', repoPath: '/other' });
      spend(db, 'b', 4);
      insertDodItems(db, 'a', ['x'], 't', () => 'ia');
      setDodState(db, 'ia', 'met', {}, 't');
      insertDodItems(db, 'b', ['y'], 't', () => 'ib');
      return db;
    };

    it('searches the goal, case-insensitively', () => {
      expect(listCases(seeded(), { search: 'PARSER' }).map((c) => c.id)).toEqual(['a']);
    });

    it('filters by outcome, mandate, runtime and repository', () => {
      const db = seeded();
      expect(listCases(db, { outcomes: ['failed'] }).map((c) => c.id)).toEqual(['b']);
      expect(listCases(db, { mandateIds: ['builtin-investigate'] }).map((c) => c.id)).toEqual(['a']);
      expect(listCases(db, { runtimes: ['codex'] }).map((c) => c.id)).toEqual(['a']);
      expect(listCases(db, { repoPaths: ['/other'] }).map((c) => c.id)).toEqual(['b']);
    });

    it('filters by cost', () => {
      const db = seeded();
      expect(listCases(db, { minCostUsd: 1 }).map((c) => c.id)).toEqual(['b']);
      expect(listCases(db, { maxCostUsd: 1 }).map((c) => c.id)).toEqual(['a']);
    });

    it('does not call a case with no checks "fully met"', () => {
      const db = createDb(TEST_DB);
      node(db, { id: 'nochecks' });
      expect(listCases(db, { dod: 'met' })).toEqual([]);
      expect(listCases(db, { dod: 'outstanding' }).map((c) => c.id)).toEqual(['nochecks']);
    });

    it('filters met against outstanding', () => {
      const db = seeded();
      expect(listCases(db, { dod: 'met' }).map((c) => c.id)).toEqual(['a']);
      expect(listCases(db, { dod: 'outstanding' }).map((c) => c.id)).toEqual(['b']);
    });
  });

  it('offers only facets that something actually used', () => {
    const db = createDb(TEST_DB);
    seedBuiltinMandates(db, 't');
    node(db, { id: 'a', mandateId: 'builtin-investigate', runtime: 'codex', repoPath: '/repo' });
    const facets = caseFacets(db);
    expect(facets.runtimes).toEqual(['codex']);
    expect(facets.repoPaths).toEqual(['/repo']);
    expect(facets.mandates).toEqual([{ id: 'builtin-investigate', name: 'Investigate' }]);
  });
});

describe('listAttention', () => {
  const NOW = Date.parse('2026-09-01T01:00:00.000Z');

  it('puts a person`s decision above everything else', () => {
    const db = createDb(TEST_DB);
    node(db, { id: 'root', state: 'WAIT_APPROVAL', updatedAt: '2026-09-01T00:00:00.000Z' });
    node(db, { id: 'broke', parent: 'root', budget: 1, state: 'SELF_EXECUTE', updatedAt: '2026-09-01T00:59:00.000Z' });
    spend(db, 'broke', 5);
    insertApproval(db, { id: 'a1', nodeId: 'root', reason: 'needs more budget', status: 'pending', createdAt: 't' });

    const items = listAttention(db, NOW);
    expect(items[0].kind).toBe('approval');
    expect(items.map((i) => i.kind)).toContain('over_budget');
  });

  it('surfaces a node that went quiet, and says for how long', () => {
    const db = createDb(TEST_DB);
    node(db, { id: 'quiet', state: 'SELF_EXECUTE', updatedAt: '2026-09-01T00:00:00.000Z' });
    const stalled = listAttention(db, NOW).find((i) => i.kind === 'stalled')!;
    expect(stalled.detail).toContain('60 minutes');
  });

  it('does not call a finished node stalled', () => {
    const db = createDb(TEST_DB);
    node(db, { id: 'done', state: 'COMPLETE', updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(listAttention(db, NOW).some((i) => i.kind === 'stalled')).toBe(false);
  });

  it('surfaces an interrupted node as resumable work', () => {
    const db = createDb(TEST_DB);
    node(db, { id: 'parked', state: 'INTERRUPTED' });
    const item = listAttention(db, NOW).find((i) => i.kind === 'interrupted')!;
    expect(item.detail).toContain('resume');
  });

  it('surfaces a case that finished without meeting what it promised', () => {
    const db = createDb(TEST_DB);
    node(db, { id: 'root', state: 'COMPLETE' });
    insertDodItems(db, 'root', ['ship it'], 't', () => 'i1');
    setDodState(db, 'i1', 'unmet', {}, 't');
    expect(listAttention(db, NOW).some((i) => i.kind === 'dod_unmet')).toBe(true);
  });

  it('attributes every item to the case it belongs to, however deep', () => {
    const db = createDb(TEST_DB);
    node(db, { id: 'root', goal: 'the big goal' });
    node(db, { id: 'mid', parent: 'root' });
    node(db, { id: 'leaf', parent: 'mid', state: 'INTERRUPTED' });
    const item = listAttention(db, NOW).find((i) => i.kind === 'interrupted')!;
    expect(item.caseId).toBe('root');
    expect(item.caseGoal).toBe('the big goal');
    expect(item.nodeId).toBe('leaf');
  });

  it('is empty when nothing needs anyone', () => {
    const db = createDb(TEST_DB);
    node(db, { id: 'done', state: 'COMPLETE', updatedAt: '2026-09-01T00:59:00.000Z' });
    expect(listAttention(db, NOW)).toEqual([]);
  });
});
