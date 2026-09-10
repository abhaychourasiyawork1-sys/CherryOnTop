import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from 'vitest';
import { existsSync, unlinkSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDb } from '../db/client.js';
import { getNode, insertNode, listNodes } from '../db/queries/nodes.js';
import { startNodeActor } from './node-actor-manager.js';
import type { ExecuteStepInput, ExecuteStepResult } from '../execution/execute-step.js';
import { ZERO_USAGE } from '../execution/tokens.js';

// Same shape as the execute-dispatch test: stubbing the module is what makes
// the prompt each dispatch is given observable at all. Everything else — the
// state machine, the DB, the caches, the economics — is the real thing.
vi.mock('../execution/execute-step.js', () => ({ executeStep: vi.fn() }));
vi.mock('../k8s/cleanup.js', () => ({
  deleteNodeNetworkPolicy: vi.fn(async () => {}),
  deleteNodeJobs: vi.fn(async () => {}),
}));

const { executeStep } = await import('../execution/execute-step.js');
const stub = executeStep as unknown as Mock;

const TEST_DB = './test-actor-plan.db';
// Breadth terms and two distinct work types: what assessDecomposition scores as
// worth splitting, so the node reaches a planning dispatch at all.
const GOAL = 'Audit every module in the cart package for unhandled errors and add tests across all of them';

function result(text: string): ExecuteStepResult {
  return {
    succeeded: true, message: 'done',
    events: [{ type: 'result', payload: { is_error: false, result: text } }],
    usage: { ...ZERO_USAGE },
  };
}

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plan-actor-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  mkdirSync(join(dir, 'src', 'cart'), { recursive: true });
  writeFileSync(join(dir, 'src', 'cart', 'checkout.ts'), 'export function checkout() {}\n');
  writeFileSync(join(dir, 'unrelated.ts'), 'export const x = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

/** Drives one delegating node to a terminal state and returns every dispatch it
 *  made. `planAnswer` is what the planning run replies with. */
async function runDelegating(db: ReturnType<typeof createDb>, repoPath: string, planAnswer: string): Promise<ExecuteStepInput[]> {
  const calls: ExecuteStepInput[] = [];
  stub.mockImplementation(async (input: ExecuteStepInput) => {
    calls.push(input);
    return result(planAnswer);
  });

  const id = randomUUID();
  insertNode(db, {
    id, parentId: null, goal: GOAL, repoPath, state: 'CREATED',
    createdAt: 't0', updatedAt: 't0',
    contract: {
      goal: GOAL, definition_of_done: ['every module audited'],
      authority: { tools: [], spawn_children: true, max_child_count: 3, budget_usd: 10 },
      constraints: [],
    },
  });

  startNodeActor(db, id, GOAL);
  await vi.waitFor(
    () => expect(['COMPLETE', 'FAILED', 'CANCELLED']).toContain(getNode(db, id)?.state),
    { timeout: 10_000 },
  );
  return calls;
}

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ORG_REPO_MAP_TOKENS;
  vi.clearAllMocks();
});

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ORG_REPO_MAP_TOKENS = '6000';
});

describe('the planning dispatch', () => {
  it('hands the planner the repository context instead of making it explore from zero', async () => {
    const calls = await runDelegating(createDb(TEST_DB), tmpRepo(), '[]');
    const plan = calls[0];
    expect(plan.goal).toContain('Repository shape:');
    expect(plan.goal).toContain('src/cart/checkout.ts');
    // Selected, not dumped: a file the goal never mentions stays out of the
    // planner's prompt too.
    expect(plan.goal).not.toContain('unrelated.ts');
  });

  it('does not buy a second sandbox to be told again that a goal does not split', async () => {
    const db = createDb(TEST_DB);
    const repoPath = tmpRepo();

    const isPlanning = (input: ExecuteStepInput) => input.goal.includes('Split this goal');

    const first = await runDelegating(db, repoPath, '[]');
    expect(first.filter(isPlanning)).toHaveLength(1);

    // Same goal, same committed HEAD, so the answer cannot have changed. The
    // node still executes the work itself — it just does not pay a planner to
    // repeat "this does not split".
    const second = await runDelegating(db, repoPath, '[]');
    expect(second.filter(isPlanning)).toHaveLength(0);
    expect(second.length).toBeGreaterThan(0);
  });

  it('still reuses a real split from the cache', async () => {
    const db = createDb(TEST_DB);
    const repoPath = tmpRepo();
    const split = JSON.stringify(['Audit src/cart for unhandled errors', 'Add tests for src/cart']);

    await runDelegating(db, repoPath, split);
    const before = listNodes(db).length;

    const second = await runDelegating(db, repoPath, split);
    // No planning dispatch the second time, and children were still spawned
    // from the cached plan.
    expect(second.filter((input) => input.goal.includes('Split this goal'))).toHaveLength(0);
    expect(listNodes(db).length).toBeGreaterThan(before);
  });

  it('routes each role on its own merits, not on one shared setting', async () => {
    const calls = await runDelegating(createDb(TEST_DB), tmpRepo(), '[]');

    // Planning is a narrow job — emit a JSON array — and runs on the fast tier.
    expect(calls[0].goal).toContain('Split this goal');
    expect(calls[0].model).toBe('haiku');

    // The work itself is not. This goal scores high complexity, so it stays on
    // the runtime's own default: no --model flag at all.
    const work = calls.find((call) => !call.goal.includes('Split this goal'));
    expect(work).toBeDefined();
    expect(work!.model).toBeUndefined();
  });
});
