import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from 'vitest';
import { existsSync, unlinkSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDb, type Db } from '../db/client.js';
import { getNode, insertNode } from '../db/queries/nodes.js';
import { listEventsForNode } from '../db/queries/events.js';
import { startNodeActor } from './node-actor-manager.js';
import type { ExecuteStepInput, ExecuteStepResult } from '../execution/execute-step.js';
import { ZERO_USAGE } from '../execution/tokens.js';
import { successfulRunEvents, replayInto } from './run-fixtures.js';
import { summarizeContextLedger, type ContextLedgerRecord } from '../observability/context-ledger.js';

// The prompt the lifecycle hands the runtime is assembled by the prompt
// compiler under one budget. These tests drive the real machine with the
// sandbox stubbed, and look at exactly what would have been dispatched.
vi.mock('../execution/execute-step.js', () => ({ executeStep: vi.fn() }));
vi.mock('../k8s/cleanup.js', () => ({
  deleteNodeNetworkPolicy: vi.fn(async () => {}),
  deleteNodeJobs: vi.fn(async () => {}),
}));

const { executeStep } = await import('../execution/execute-step.js');
const stub = executeStep as unknown as Mock;

const TEST_DB = './test-actor-prompt.db';
const GOAL = 'Fix the failing test in the cart module';

const OK: ExecuteStepResult = {
  succeeded: true, message: 'done', usage: { ...ZERO_USAGE, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 900, numTurns: 4 },
  events: successfulRunEvents({ editedPath: '/workspace/src/cart/checkout.ts', verifyCommand: 'npm test', result: 'fixed it' }),
};

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-actor-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  mkdirSync(join(dir, 'src', 'cart'), { recursive: true });
  writeFileSync(join(dir, 'src', 'cart', 'checkout.ts'), 'export function checkout() {}\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

function makeNode(db: Db, goal: string): string {
  const id = randomUUID();
  insertNode(db, {
    id, parentId: null, goal, repoPath: tmpRepo(), state: 'CREATED', createdAt: 't0', updatedAt: 't0',
    contract: { goal, definition_of_done: ['the test passes'], authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 1 }, constraints: [] },
  });
  return id;
}

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ORG_PROMPT_ARG_BYTES;
  delete process.env.ORG_ROLE_PROMPTS;
  vi.clearAllMocks();
});

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

function ledgerRecords(db: Db, nodeId: string): ContextLedgerRecord[] {
  return listEventsForNode(db, nodeId)
    .filter((e) => e.type === 'context.ledger')
    .flatMap((e) => (e.payload as { records: ContextLedgerRecord[] }).records);
}

describe('the prompt the lifecycle dispatches', () => {
  it('leaves one correlated ledger trace per dispatch: what the prompt was made of, then what the run spent', async () => {
    const db = createDb(TEST_DB);
    const calls: ExecuteStepInput[] = [];
    stub.mockImplementation(async (input: ExecuteStepInput) => { calls.push(input); return replayInto(input, OK); });
    const id = makeNode(db, GOAL);
    startNodeActor(db, id, GOAL);
    await vi.waitFor(() => expect(getNode(db, id)?.state).toBe('COMPLETE'), { timeout: 10_000 });

    const records = ledgerRecords(db, id);
    const executeTrace = records.filter((r) => r.dispatchId.includes('/execute/'));
    expect(new Set(executeTrace.map((r) => r.dispatchId)).size).toBe(1);
    expect(executeTrace.some((r) => r.phase === 'compile' && r.kind === 'goal')).toBe(true);
    const model = executeTrace.find((r) => r.phase === 'model');
    expect(model?.tokens).toBe(1500);
    expect(model?.reason).toContain('cacheRead=900');
    // Counts and references only: the goal text is not in the trace.
    expect(JSON.stringify(records)).not.toContain(GOAL);
    expect(summarizeContextLedger(records).dispatches).toBeGreaterThanOrEqual(1);
  });

  it('refuses to dispatch a goal that cannot fit the runtime input limit, and says why', async () => {
    process.env.ORG_PROMPT_ARG_BYTES = '2000';
    const db = createDb(TEST_DB);
    stub.mockImplementation(async (input: ExecuteStepInput) => replayInto(input, OK));
    const goal = `${GOAL}. ${'Details of the failure. '.repeat(500)}`;
    const id = makeNode(db, goal);
    startNodeActor(db, id, goal);
    await vi.waitFor(() => expect(getNode(db, id)?.state).toBe('FAILED'), { timeout: 10_000 });

    // Not one byte of it reached a sandbox, and nothing was cut down to fit.
    expect(stub).not.toHaveBeenCalled();
    const outcomes = listEventsForNode(db, id).filter((e) => e.type === 'step.outcome' || e.type === 'exec.outcome');
    const text = JSON.stringify([...outcomes, ...ledgerRecords(db, id)]);
    expect(text).toMatch(/cannot fit|refused/);
  });

  it('sheds the repository map before it ever touches the goal when the ceiling is tight', async () => {
    const db = createDb(TEST_DB);
    const calls: ExecuteStepInput[] = [];
    stub.mockImplementation(async (input: ExecuteStepInput) => { calls.push(input); return replayInto(input, OK); });

    // A ceiling the goal fits under but the goal plus a repository map does not.
    // Role prompts off, so the only thing on the user channel besides the map is
    // the goal (the role prompt has its own channel and its own ceiling).
    process.env.ORG_ROLE_PROMPTS = 'off';
    process.env.ORG_PROMPT_ARG_BYTES = String(Buffer.byteLength(GOAL) + 20);
    const id = makeNode(db, GOAL);
    startNodeActor(db, id, GOAL);
    await vi.waitFor(() => expect(getNode(db, id)?.state).toBe('COMPLETE'), { timeout: 10_000 });

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.goal).toContain(GOAL);
      expect(call.goal).not.toContain('Repository context');
      expect(Buffer.byteLength(call.goal)).toBeLessThanOrEqual(Buffer.byteLength(GOAL) + 20);
    }
  });
});
