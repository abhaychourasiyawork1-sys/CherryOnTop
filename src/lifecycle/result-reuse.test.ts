/** The same read-only question, asked twice against the same commit, costs one
 *  sandbox.
 *
 *  The plan cache already proved the rule on the cheap half of the problem: the
 *  same goal against the same committed tree splits the same way, so do not pay
 *  a planner twice. This is the same rule applied where the money is. In the one
 *  fully measured run a planning dispatch cost $0.045 and a read-only execute
 *  dispatch cost $0.95 over 42 turns and 1.77M cache-read tokens — and
 *  "review the codebase and find bugs" is exactly the goal people re-ask.
 *
 *  Only read-only dispatches. Reusing the answer of a run that *changed*
 *  something would skip the change and report it done, which is not a saving. */
import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from 'vitest';
import { existsSync, unlinkSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.ANTHROPIC_API_KEY = 'test-key';

vi.mock('../execution/execute-step.js', () => ({ executeStep: vi.fn() }));
vi.mock('../k8s/cleanup.js', () => ({
  deleteNodeNetworkPolicy: vi.fn(async () => {}),
  deleteNodeJobs: vi.fn(async () => {}),
}));

const { createDb } = await import('../db/client.js');
const { insertNode, getNode } = await import('../db/queries/nodes.js');
const { answerOf } = await import('../db/queries/answers.js');
const { tokensByRole } = await import('../db/queries/tokens.js');
const { startNodeActor } = await import('./node-actor-manager.js');
const { executeStep } = await import('../execution/execute-step.js');
const { ZERO_USAGE } = await import('../execution/tokens.js');

const stub = executeStep as unknown as Mock;
const TEST_DB = './test-result-reuse.db';

// Read-only and one unit of work, so the node goes straight to SELF_EXECUTE.
const GOAL = 'Review the README and report what it claims. Do not modify anything.';
const ANSWER = 'It claims three things, two of which are stale.';

const REPORT = {
  succeeded: true,
  message: 'Job completed successfully',
  events: [{ type: 'result', payload: { result: ANSWER, total_cost_usd: 0.95 } }],
  usage: { ...ZERO_USAGE, inputTokens: 40, outputTokens: 12_000, cacheReadTokens: 1_772_218 },
};

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
  delete process.env.ORG_RESULT_CACHE_TTL_HOURS;
  vi.clearAllMocks();
});

beforeEach(() => { stub.mockResolvedValue(REPORT); });

/** A real git repository with a real commit: the cache keys on committed HEAD
 *  and refuses a dirty tree, so a fake path would only ever test the miss. */
function repo(): string {
  const path = mkdtempSync(join(tmpdir(), 'result-reuse-'));
  writeFileSync(join(path, 'README.md'), '# claims\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '.');
  git('commit', '-qm', 'first');
  return path;
}

function add(db: ReturnType<typeof createDb>, repoPath: string, tools: string[]): string {
  const id = randomUUID();
  insertNode(db, {
    id, parentId: null, goal: GOAL, repoPath, state: 'CREATED',
    createdAt: 't0', updatedAt: 't0',
    contract: {
      goal: GOAL, definition_of_done: ['reported'],
      authority: { tools, spawn_children: false, max_child_count: 0, budget_usd: 0 },
      constraints: [],
    },
  });
  return id;
}

async function run(db: ReturnType<typeof createDb>, id: string): Promise<void> {
  startNodeActor(db, id, GOAL);
  await vi.waitFor(() => expect(getNode(db, id)?.state).toMatch(/COMPLETE|FAILED/), { timeout: 10_000 });
}

const READ_ONLY = ['Read', 'Grep'];

describe('a read-only question asked twice against the same commit', () => {
  it('runs one sandbox and serves the second from the first answer', async () => {
    const db = createDb(TEST_DB);
    const path = repo();

    const first = add(db, path, READ_ONLY);
    await run(db, first);
    expect(stub).toHaveBeenCalledTimes(1);

    const second = add(db, path, READ_ONLY);
    await run(db, second);

    expect(stub).toHaveBeenCalledTimes(1);
    // The reused run left no transcript of its own, so the answer has to be
    // published as one — otherwise the node finishes having said nothing.
    expect(answerOf(db, second)).toBe(ANSWER);
    expect(getNode(db, second)?.state).toBe('COMPLETE');

    const tokens = tokensByRole(db);
    expect(tokens.resultCacheHits).toBe(1);
    // A dispatch that did not happen is not a dispatch with zero tokens.
    expect(tokens.rows.filter((r) => r.role === 'execute')).toHaveLength(1);
  });

  it('records the hit as work avoided, priced at what it cost last time', async () => {
    const db = createDb(TEST_DB);
    const path = repo();
    await run(db, add(db, path, READ_ONLY));
    const second = add(db, path, READ_ONLY);
    await run(db, second);

    const { loadEfficiencyRecords } = await import('../efficiency/ledger.js');
    const record = loadEfficiencyRecords(db).find((r) => r.taskId === second)!;
    expect(record.avoidedExecutionCalls).toBe(1);
    expect(record.tokensAvoided).toBe(40 + 12_000);
    expect(record.totalTokens).toBe(0);
    expect(record.workAvoidedRatio).toBe(1);
  });

  it('never reuses an answer for a node that may write', async () => {
    const db = createDb(TEST_DB);
    const path = repo();
    await run(db, add(db, path, READ_ONLY));
    // Same goal, same commit — but this node could change something, and the
    // change is what a reused answer would silently skip.
    await run(db, add(db, path, ['Read', 'Edit', 'Write']));
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it('never reuses an answer once the tree has moved on', async () => {
    const db = createDb(TEST_DB);
    const path = repo();
    await run(db, add(db, path, READ_ONLY));

    // Uncommitted work: the answer describes a tree that no longer exists, and
    // `repoDirty` reports true whenever it cannot tell. Same rule as the plan
    // cache — an unknowable tree is never keyed.
    writeFileSync(join(path, 'README.md'), '# claims\nand another\n');
    await run(db, add(db, path, READ_ONLY));
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it('is off when the operator turns it off', async () => {
    process.env.ORG_RESULT_CACHE_TTL_HOURS = '0';
    const db = createDb(TEST_DB);
    const path = repo();
    await run(db, add(db, path, READ_ONLY));
    await run(db, add(db, path, READ_ONLY));
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it('does not store an answer from a run that failed', async () => {
    const db = createDb(TEST_DB);
    const path = repo();
    stub.mockResolvedValue({ ...REPORT, succeeded: false, message: 'Request timed out' });
    await run(db, add(db, path, READ_ONLY));

    stub.mockResolvedValue(REPORT);
    const second = add(db, path, READ_ONLY);
    await run(db, second);
    // Counted per node, not in total: a failed dispatch is retried by the state
    // machine, so the first node made several attempts. What matters is that
    // none of them left an answer behind for the second node to reuse.
    expect(stub.mock.calls.some((call) => call[0].nodeId === second)).toBe(true);
  });
});
