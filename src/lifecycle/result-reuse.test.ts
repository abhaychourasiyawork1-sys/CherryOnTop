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

/** The run says what it read, the way a real one does: a `tool_use` block in an
 *  assistant event. That is what the dependency fingerprint is built from. */
const readEvent = (path: string) => ({
  type: 'assistant',
  payload: { message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: `/workspace/${path}` } }] } },
});

const REPORT = {
  succeeded: true,
  message: 'Job completed successfully',
  events: [readEvent('README.md'), { type: 'result', payload: { result: ANSWER, total_cost_usd: 0.95 } }],
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
  writeFileSync(join(path, 'unrelated.ts'), 'export const x = 1;\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  commit(path);
  return path;
}

function commit(path: string): void {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'ignore' });
  git('add', '-A');
  git('commit', '-qm', 'x');
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

  it('survives a commit that touched nothing the answer depended on', async () => {
    // The headline claim, and the reason validity is dependency-based rather
    // than keyed on HEAD. Keying on the commit means one change to an unrelated
    // file invalidates every cached answer about every module — which in a
    // repository anyone is working in is a cache that never hits.
    const db = createDb(TEST_DB);
    const path = repo();
    await run(db, add(db, path, READ_ONLY));

    writeFileSync(join(path, 'unrelated.ts'), 'export const x = 2;\n');
    commit(path);

    await run(db, add(db, path, READ_ONLY));
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('does not survive a commit to a file the answer was read from', async () => {
    const db = createDb(TEST_DB);
    const path = repo();
    await run(db, add(db, path, READ_ONLY));

    writeFileSync(join(path, 'README.md'), '# claims\nand another\n');
    commit(path);

    await run(db, add(db, path, READ_ONLY));
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it('never reuses an answer against a dirty tree', async () => {
    const db = createDb(TEST_DB);
    const path = repo();
    await run(db, add(db, path, READ_ONLY));

    // Uncommitted work is described by no commit, so nothing committed can
    // vouch for it. `repoDirty` reports true whenever it cannot tell.
    writeFileSync(join(path, 'README.md'), '# claims\nand another\n');
    await run(db, add(db, path, READ_ONLY));
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it('falls back to an exact commit match when it cannot see what was read', async () => {
    // A shell command can read anything. An answer whose inputs we cannot name
    // is only reusable at the exact commit it was given.
    const db = createDb(TEST_DB);
    const path = repo();
    stub.mockResolvedValue({
      ...REPORT,
      events: [
        { type: 'assistant', payload: { message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cat README.md' } }] } } },
        { type: 'result', payload: { result: ANSWER, total_cost_usd: 0.95 } },
      ],
    });
    await run(db, add(db, path, READ_ONLY));

    // Same commit: reusable.
    await run(db, add(db, path, READ_ONLY));
    expect(stub).toHaveBeenCalledTimes(1);

    // An unrelated commit it could not be shown to be unaffected by: not.
    writeFileSync(join(path, 'unrelated.ts'), 'export const x = 3;\n');
    commit(path);
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
