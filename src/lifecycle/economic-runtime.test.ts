import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from 'vitest';
import { existsSync, unlinkSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDb } from '../db/client.js';
import { getNode, insertNode } from '../db/queries/nodes.js';
import { appendEvent, listEventsForNode } from '../db/queries/events.js';
import { recordDispatchUsage } from '../db/queries/tokens.js';
import { insertDodItems, listDodForNode, setDodState } from '../db/queries/dod.js';
import { startNodeActor } from './node-actor-manager.js';
import { economicStateFor, evaluateBoundary, forgetNode, trackedNodeCount, isIntervention } from './economic-runtime.js';
import type { ExecuteStepInput, ExecuteStepResult } from '../execution/execute-step.js';
import { ZERO_USAGE } from '../execution/tokens.js';
import { actionCandidate } from '../decision/actions.js';
import { dispatchContextFor } from '../context/dispatch-context-cache.js';
import { withRepoContext } from '../intelligence/repo-map.js';

vi.mock('../execution/execute-step.js', () => ({ executeStep: vi.fn() }));
vi.mock('../k8s/cleanup.js', () => ({
  deleteNodeNetworkPolicy: vi.fn(async () => {}),
  deleteNodeJobs: vi.fn(async () => {}),
}));

const { executeStep } = await import('../execution/execute-step.js');
const stub = executeStep as unknown as Mock;

const TEST_DB = './test-economic-runtime.db';
const GOAL = 'Fix the failing checkout test in src/cart/checkout.ts';

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'econ-runtime-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  mkdirSync(join(dir, 'src', 'cart'), { recursive: true });
  writeFileSync(join(dir, 'src', 'cart', 'checkout.ts'), 'export function checkout() { return 1; }\n');
  writeFileSync(join(dir, 'src', 'cart', 'checkout.test.ts'), "import { checkout } from './checkout.js';\n");
  for (let i = 0; i < 4; i++) writeFileSync(join(dir, `unrelated-${i}.ts`), 'export const x = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

const OK: ExecuteStepResult = {
  succeeded: true, message: 'done',
  events: [{ type: 'result', payload: { is_error: false, result: 'fixed it' } }],
  usage: { ...ZERO_USAGE },
};

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ORG_EFFICIENCY_MODE;
  vi.clearAllMocks();
});

beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'test-key'; });

function seedNode(db: ReturnType<typeof createDb>, repo: string, dod: string[] = ['the test passes']): string {
  const id = randomUUID();
  insertNode(db, {
    id, parentId: null, goal: GOAL, repoPath: repo, state: 'CREATED',
    createdAt: 't0', updatedAt: 't0',
    contract: {
      goal: GOAL, definition_of_done: dod,
      authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 1 },
      constraints: [],
    },
  });
  return id;
}

/** One tool call and its result, as the runtime records them under `exec.*`. */
function recordToolCall(
  db: ReturnType<typeof createDb>, nodeId: string,
  name: string, input: Record<string, unknown>, failed = false, output = 'ok',
): void {
  const id = randomUUID();
  appendEvent(db, {
    nodeId, type: 'exec.assistant', createdAt: new Date().toISOString(),
    payload: { message: { content: [{ type: 'tool_use', id, name, input }] } },
  });
  appendEvent(db, {
    nodeId, type: 'exec.user', createdAt: new Date().toISOString(),
    payload: { message: { content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: failed }] } },
  });
}

describe('the state is assembled from what the runtime already records', () => {
  it('reads consumed tokens and turns off the rows recordUsage already writes', () => {
    const db = createDb(TEST_DB);
    const id = seedNode(db, tmpRepo());
    recordDispatchUsage(db, {
      nodeId: id, role: 'execute', model: null, costUsd: 0.1, createdAt: 't1',
      usage: { inputTokens: 20_000, outputTokens: 2_000, cacheReadTokens: 0, cacheCreationTokens: 0, numTurns: 4 },
    });

    const state = economicStateFor(db, { nodeId: id, goal: GOAL });
    expect(state.resources.consumedTokens).toBe(22_000);
    // The budget is the task's own measured rate, not a constant: 22,000 over
    // four turns is 5,500 a turn, against whatever turn cap the policy set.
    expect(state.resources.totalTokenBudget).toBeGreaterThan(22_000);
    forgetNode(id);
  });

  it('reads evidence off the run’s own tool stream', () => {
    const db = createDb(TEST_DB);
    const id = seedNode(db, tmpRepo());
    recordToolCall(db, id, 'Read', { file_path: 'src/cart/checkout.ts' });
    recordToolCall(db, id, 'Edit', { file_path: 'src/cart/checkout.ts' });
    recordToolCall(db, id, 'Grep', { pattern: 'checkout' });

    const state = economicStateFor(db, { nodeId: id, goal: GOAL, repositoryRevision: 'abc' });
    const ids = state.evidence.map((e) => e.id);
    expect(ids).toContain('observed:src/cart/checkout.ts');
    expect(ids).toContain('observed:checkout');
    // A file that was edited is a fact about the tree; one merely searched for
    // is a weaker observation.
    const edited = state.evidence.find((e) => e.id === 'observed:src/cart/checkout.ts')!;
    expect(edited.kind).toBe('fact');
    expect(edited.repositoryRevision).toBe('abc');
    forgetNode(id);
  });

  it('reads validation off the definition of done rather than inventing a parallel notion', () => {
    const db = createDb(TEST_DB);
    const id = seedNode(db, tmpRepo());
    insertDodItems(db, id, ['the test passes', 'nothing else changed'], 't0', (i) => `dod-${i}`);

    expect(economicStateFor(db, { nodeId: id, goal: GOAL }).validation.status).toBe('pending');
    forgetNode(id);

    for (const item of listDodForNode(db, id)) {
      setDodState(db, item.id, 'met', { note: 'seen' }, 't1');
    }
    expect(economicStateFor(db, { nodeId: id, goal: GOAL }).validation.status).toBe('passed');
    forgetNode(id);
  });

  it('trusts its own reading less when the run has barely acted', () => {
    const db = createDb(TEST_DB);
    const quiet = seedNode(db, tmpRepo());
    const busy = seedNode(db, tmpRepo());
    for (let i = 0; i < 8; i++) recordToolCall(db, busy, 'Read', { file_path: `src/f${i}.ts` });

    const early = economicStateFor(db, { nodeId: quiet, goal: GOAL });
    const later = economicStateFor(db, { nodeId: busy, goal: GOAL });
    expect(early.trajectory.orchestrationConfidence).toBeLessThan(later.trajectory.orchestrationConfidence);
    forgetNode(quiet);
    forgetNode(busy);
  });

  it('never throws on a node with no history at all', () => {
    const db = createDb(TEST_DB);
    const id = seedNode(db, tmpRepo());
    const state = economicStateFor(db, { nodeId: id, goal: GOAL });
    expect(state.version).toBe(0);
    expect(state.resources.consumedTokens).toBe(0);
    forgetNode(id);
  });
});

describe('the agent executes unchanged when there is no opportunity', () => {
  it('intervenes in nothing on a healthy first dispatch', async () => {
    const db = createDb(TEST_DB);
    const repo = tmpRepo();
    const calls: ExecuteStepInput[] = [];
    stub.mockImplementation(async (input: ExecuteStepInput) => { calls.push(input); return OK; });

    const id = seedNode(db, repo);
    startNodeActor(db, id, GOAL);
    await vi.waitFor(() => expect(getNode(db, id)?.state).toBe('COMPLETE'), { timeout: 10_000 });

    expect(calls).toHaveLength(1);
    // The tell: nothing was prepended. A dispatch the control plane did not
    // touch is byte-identical to one made without a control plane.
    expect(calls[0].goal).not.toContain('rather than letting the agent go and find it');
    expect(calls[0].goal).not.toContain('Contents of');
  });

  it('dispatches exactly the prompt the context planner alone would have built', async () => {
    // The strongest form of "CONTINUE is a true no-op": the goal that reaches
    // the sandbox is reconstructible without the control plane existing. Any
    // byte the boundary contributed would show up here.
    const db = createDb(TEST_DB);
    const repo = tmpRepo();
    const calls: ExecuteStepInput[] = [];
    stub.mockImplementation(async (input: ExecuteStepInput) => { calls.push(input); return OK; });

    const id = seedNode(db, repo);
    startNodeActor(db, id, GOAL);
    await vi.waitFor(() => expect(getNode(db, id)?.state).toBe('COMPLETE'), { timeout: 10_000 });

    const context = dispatchContextFor(db, repo, GOAL);
    expect(calls[0].goal).toBe(context ? withRepoContext(GOAL, context.content) : GOAL);
  });

  it('records what looking cost even when it decided nothing', async () => {
    const db = createDb(TEST_DB);
    stub.mockImplementation(async () => OK);
    const id = seedNode(db, tmpRepo());
    startNodeActor(db, id, GOAL);
    await vi.waitFor(() => expect(getNode(db, id)?.state).toBe('COMPLETE'), { timeout: 10_000 });

    const decisions = listEventsForNode(db, id).filter((e) => e.type === 'economic.decision');
    expect(decisions.length).toBeGreaterThan(0);
    const payload = decisions[0].payload as { tokens: number; reason: string };
    // A cost only recorded when the orchestrator acted would make it look free
    // exactly when it is not.
    expect(payload.tokens).toBeGreaterThan(0);
    expect(payload.reason).toContain('fast-path');
  });
});

describe('evaluateBoundary', () => {
  it('turns a selector request into a comparable action rather than acting on it directly', () => {
    const db = createDb(TEST_DB);
    const id = seedNode(db, tmpRepo());
    // A run that is failing and getting nowhere, so the screen has something to
    // see and the deep path runs.
    for (let i = 0; i < 6; i++) {
      recordToolCall(db, id, 'Bash', { command: 'npm test' }, true, 'error: checkout is not a function');
    }
    const outcome = evaluateBoundary(db, {
      nodeId: id, goal: GOAL, repositoryRevision: 'abc',
      fullArtifactRequests: [{ path: 'src/cart/checkout.ts', tokens: 40, expectedNetValue: 5_000 }],
    });
    const ids = outcome.cycle.candidates.map((c) => c.id);
    expect(ids).toContain('evidence:src/cart/checkout.ts');
    const candidate = outcome.cycle.candidates.find((c) => c.id === 'evidence:src/cart/checkout.ts')!;
    expect(candidate.kind).toBe('acquire_evidence');
    expect(candidate.metadata.path).toBe('src/cart/checkout.ts');
    // Benefit and cost apart: the selector reports them combined, and the
    // candidate contract needs them separately to be comparable.
    expect(candidate.tokenCost).toBe(40);
    expect(candidate.expectedTokenBenefit).toBe(5_040);
    forgetNode(id);
  });

  it('carries the cadence forward so a quiet run is screened less often', () => {
    const db = createDb(TEST_DB);
    const id = seedNode(db, tmpRepo());
    const first = evaluateBoundary(db, { nodeId: id, goal: GOAL });
    const second = evaluateBoundary(db, { nodeId: id, goal: GOAL });
    expect(first.cycle.cadence.interval).toBeGreaterThanOrEqual(1);
    // The second boundary is either due or deliberately skipped; either way the
    // cadence advanced rather than restarting.
    expect(second.cycle.cadence.lastEvaluatedVersion).toBeGreaterThanOrEqual(
      first.cycle.cadence.lastEvaluatedVersion,
    );
    forgetNode(id);
  });

  it('forgets a node so a long-lived daemon does not accumulate one entry per run', () => {
    const db = createDb(TEST_DB);
    const before = trackedNodeCount();
    const id = seedNode(db, tmpRepo());
    evaluateBoundary(db, { nodeId: id, goal: GOAL });
    expect(trackedNodeCount()).toBe(before + 1);
    forgetNode(id);
    expect(trackedNodeCount()).toBe(before);
  });
});

describe('isIntervention', () => {
  it('treats continuing and deciding nothing as the same no-op', () => {
    expect(isIntervention(undefined)).toBe(false);
    expect(isIntervention({
      decisionId: 'd', stateVersion: 1, utility: 0, reasonCodes: [], confidence: 1,
      action: actionCandidate({ id: 'c', kind: 'continue', capability: 'agent.continue' }),
    })).toBe(false);
  });

  it('treats anything else as something the caller must act on', () => {
    expect(isIntervention({
      decisionId: 'd', stateVersion: 1, utility: 1, reasonCodes: [], confidence: 1,
      action: actionCandidate({ id: 'e', kind: 'acquire_evidence', capability: 'evidence.read-file' }),
    })).toBe(true);
  });
});

describe('a finished execution is not a successful task', () => {
  it('records a run with no evidence as partial rather than success', async () => {
    const db = createDb(TEST_DB);
    stub.mockImplementation(async () => OK);
    const id = seedNode(db, tmpRepo());
    startNodeActor(db, id, GOAL);
    await vi.waitFor(() => expect(getNode(db, id)?.state).toBe('COMPLETE'), { timeout: 10_000 });

    const verdicts = listEventsForNode(db, id).filter((e) => e.type === 'validation.result');
    expect(verdicts).toHaveLength(1);
    const verdict = verdicts[0].payload as { passed: boolean; level: string; reasonCodes: string[] };
    // The runtime said it worked and nothing checked. That claim is exactly what
    // the ladder refuses to launder into a success.
    expect(verdict.passed).toBe(false);

    const records = listEventsForNode(db, id);
    expect(records).toBeDefined();
    const efficiency = (await import('../db/queries/memory.js')).listMemory(db, 'efficiency_record');
    expect((efficiency[0].value as { outcome: string }).outcome).toBe('partial');
  });

  it('names the ceiling it stopped at rather than leaving it to be inferred', async () => {
    const db = createDb(TEST_DB);
    stub.mockImplementation(async () => OK);
    const id = seedNode(db, tmpRepo());
    startNodeActor(db, id, GOAL);
    await vi.waitFor(() => expect(getNode(db, id)?.state).toBe('COMPLETE'), { timeout: 10_000 });

    const verdict = listEventsForNode(db, id)
      .filter((e) => e.type === 'validation.result')[0].payload as { reasonCodes: string[] };
    // This runtime cannot re-run a repository's tests from inside the daemon,
    // so the ladder stops at V2 — and says so.
    expect(verdict.reasonCodes).toContain('V3:no_verifier');
  });
});
