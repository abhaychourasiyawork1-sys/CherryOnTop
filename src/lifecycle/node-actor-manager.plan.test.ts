import { dispatchDifficulty, uninformedDifficulty } from '../intelligence/difficulty.js';
import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from 'vitest';
import { useFakeLaya } from '../system1/fake-provider.js';
import { existsSync, unlinkSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDb } from '../db/client.js';
import { getNode, insertNode, listNodes } from '../db/queries/nodes.js';
import { listEventsForNode } from '../db/queries/events.js';
import { startNodeActor } from './node-actor-manager.js';
import type { ExecuteStepInput, ExecuteStepResult } from '../execution/execute-step.js';
import { ZERO_USAGE } from '../execution/tokens.js';
import { successfulRunEvents } from './run-fixtures.js';
import { insertDodItems } from '../db/queries/dod.js';

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
async function runDelegating(db: ReturnType<typeof createDb>, repoPath: string, planAnswer: string, goal = GOAL): Promise<ExecuteStepInput[]> {
  const calls: ExecuteStepInput[] = [];
  stub.mockImplementation(async (input: ExecuteStepInput) => {
    calls.push(input);
    // Streamed the way the real executeStep does, so the run's result lands
    // as an artifact and validation sees what production would.
    const r = result(planAnswer);
    r.events.forEach((event) => input.onEvent?.(event));
    return r;
  });

  const id = randomUUID();
  insertNode(db, {
    id, parentId: null, goal, repoPath, state: 'CREATED',
    createdAt: 't0', updatedAt: 't0',
    contract: {
      goal, definition_of_done: ['every module audited'],
      authority: { tools: [], spawn_children: true, max_child_count: 3, budget_usd: 10 },
      constraints: [],
    },
  });

  startNodeActor(db, id, goal);
  await vi.waitFor(
    () => expect(['COMPLETE', 'FAILED', 'CANCELLED']).toContain(getNode(db, id)?.state),
    { timeout: 10_000 },
  );
  return calls;
}

// These paths sit behind the decomposability judgment; a fake Laya that says
// "this splits" is what lets them be reached without the old regex verdict.
let restoreSystem1: () => void = () => {};
beforeEach(() => { restoreSystem1 = useFakeLaya(0.9).restore; });
afterEach(() => restoreSystem1());

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ORG_REPO_MAP_TOKENS;
  delete process.env.ORG_EFFICIENCY_MODE;
  delete process.env.ORG_MAX_TURNS_PLAN;
  delete process.env.ORG_PLAN_OVERRIDE_P;
  vi.clearAllMocks();
});

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ORG_REPO_MAP_TOKENS = '6000';
});

describe('the planning dispatch', { timeout: 20_000 }, () => {
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
    // The planner's own verdict, so the regime where it still holds a veto:
    // below the bar where System-1 and the split score settle the question.
    process.env.ORG_PLAN_OVERRIDE_P = '1.01';
    const db = createDb(TEST_DB);
    const repoPath = tmpRepo();

    const isPlanning = (input: ExecuteStepInput) => input.goal.includes('Split this goal');

    const first = await runDelegating(db, repoPath, '[]');
    expect(first.filter(isPlanning)).toHaveLength(1);

    // Same goal, same committed HEAD, so the planner's answer cannot have
    // changed. The work itself is run again: the goal says "add tests", a
    // change request, so it runs with edit tools and is not result-cacheable.
    // (It used to be read-only because "audit" appeared in it.)
    const second = await runDelegating(db, repoPath, '[]');
    expect(second.filter(isPlanning)).toHaveLength(0);
    expect(second.length).toBeGreaterThan(0);
    expect(second.every((call) => call.grant?.readOnly !== true)).toBe(true);
  });

  it('does not cache a planner that ran out of turns as "does not split"', async () => {
    const db = createDb(TEST_DB);
    const repoPath = tmpRepo();
    const isPlanning = (input: ExecuteStepInput) => input.goal.includes('Split this goal');
    const calls: ExecuteStepInput[] = [];
    stub.mockImplementation(async (input: ExecuteStepInput) => {
      calls.push(input);
      return isPlanning(input)
        ? { succeeded: false, message: 'max turns', events: [{ type: 'result', payload: { is_error: true, subtype: 'error_max_turns' } }], usage: { ...ZERO_USAGE } }
        : result('done');
    });
    const id = randomUUID();
    insertNode(db, {
      id, parentId: null, goal: GOAL, repoPath, state: 'CREATED', createdAt: 't0', updatedAt: 't0',
      contract: { goal: GOAL, definition_of_done: ['every module audited'], authority: { tools: [], spawn_children: true, max_child_count: 3, budget_usd: 10 }, constraints: [] },
    });
    startNodeActor(db, id, GOAL);
    await vi.waitFor(() => expect(['COMPLETE', 'FAILED', 'CANCELLED']).toContain(getNode(db, id)?.state), { timeout: 10_000 });
    const notes = listEventsForNode(db, id).filter((e) => e.type === 'step.progress').map((e) => (e.payload as { message: string }).message);
    expect(notes.some((m) => /planner stopped: error_max_turns/.test(m))).toBe(true);
    expect(notes.some((m) => /does not split/.test(m))).toBe(false);

    // The next run of the same goal and HEAD plans again instead of reusing a
    // failure as a verdict.
    const again = await runDelegating(db, repoPath, JSON.stringify(['Audit src/cart for unhandled errors', 'Add tests for src/cart']));
    expect(again.filter(isPlanning)).toHaveLength(1);
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
    process.env.ORG_PLAN_OVERRIDE_P = '1.01';
    const db = createDb(TEST_DB);
    const calls = await runDelegating(db, tmpRepo(), '[]');

    // Each role is its own market decision, priced against its own difficulty:
    // the planner's job is narrower than the work's (a JSON array against a
    // turn budget a tenth the size), so for the same task it is never judged
    // harder.
    expect(calls[0].goal).toContain('Split this goal');
    const work = calls.find((call) => !call.goal.includes('Split this goal'));
    expect(work).toBeDefined();
    const receipts = listEventsForNode(db, listNodes(db).find((n) => n.parentId === null)!.id)
      .filter((e) => e.type === 'market.decision')
      .map((e) => e.payload as { role: string; difficulty: number; model: string | null });
    const plan = receipts.find((r) => r.role === 'plan')!;
    const exec = receipts.find((r) => r.role === 'execute')!;
    expect(plan.model ?? undefined).toBe(calls[0].model);
    expect(exec.model ?? undefined).toBe(work!.model);
    expect(typeof plan.difficulty).toBe('number');
    expect(typeof exec.difficulty).toBe('number');
    // Without a semantic answer, the same task is never judged a harder
    // planning job than execution job.
    expect(plan.difficulty).toBeLessThanOrEqual(dispatchDifficulty(uninformedDifficulty(), 1));
  });

  it('applies the planner turn cap to the planner Job, not just to the config', async () => {
    const calls = await runDelegating(createDb(TEST_DB), tmpRepo(), '[]');
    const plan = calls.find((call) => call.goal.includes('Split this goal'))!;
    // A measured planning run used 5 turns exploring a repository it had
    // already been handed a map of. Planning is look-then-answer; a cap that
    // only lives in config/efficiency.ts and never reaches the dispatch is not
    // a cap at all.
    expect(plan.maxTurns).toBe(6);

    // The work dispatch gets a circuit breaker rather than a budget. It was
    // uncapped, on the reasoning that a whole-codebase investigation needs its
    // turns — true, and it left the only unbounded term in the system
    // unbounded: cost inside a dispatch grows superlinearly in turns because
    // the conversation prefix is re-read on every one, and a measured 42-turn
    // run spent 1.77M cache-read tokens against a 19-turn one's 652k. 60 is
    // above every turn count ever measured here, so it costs nothing today and
    // bounds the tail. The agent is told the number (src/prompts/roles.ts) so
    // it summarises at the limit instead of being cut off at it.
    const work = calls.find((call) => !call.goal.includes('Split this goal'))!;
    expect(work.maxTurns).toBe(60);
    expect(work.systemPrompt).toMatch(/60 turns/);
  });

  it('honours an operator raising the planner turn cap', async () => {
    process.env.ORG_MAX_TURNS_PLAN = '6';
    const calls = await runDelegating(createDb(TEST_DB), tmpRepo(), '[]');
    expect(calls.find((call) => call.goal.includes('Split this goal'))!.maxTurns).toBe(6);
  });

  it('does not buy a planner, children or a synthesis run for a global review', async () => {
    // The whole 26%-of-a-window run, end to end: routing -> decomposition ->
    // dispatch -> collection. This goal is the one that was recorded splitting
    // five ways off the single word "codebase"; it has full spawn authority and
    // a $10 budget here, so nothing but the classification stops it.
    // What live Laya (typed-decisions) answers for this goal's twin, "Review
    // the codebase and check for bugs, no edits": 0.35 on "many" before
    // calibration. The classification is now System-1's, so that is the input
    // this test has to feed it.
    restoreSystem1();
    restoreSystem1 = useFakeLaya(0.35).restore;
    const db = createDb(TEST_DB);
    const calls = await runDelegating(
      db, tmpRepo(), '[]',
      'Review the codebase and find bugs. Do not modify anything.',
    );

    const root = listNodes(db).find((node) => node.parentId === null)!;
    const judged = listEventsForNode(db, root.id).find((e) => e.type === 'system1.judgment');
    expect((judged?.payload as { economicResult: { worthSplitting: boolean } }).economicResult.worthSplitting).toBe(false);
    // Only the node's own work dispatches (its validation may retry them): no
    // planner, and — below — no children and no synthesis.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => !call.goal.includes('Split this goal') && !call.goal.startsWith('THE ORIGINAL GOAL'))).toBe(true);
    // Not splitting must not silently change how the work runs: the single
    // dispatch is exactly what the market chose for it, with no override. Which
    // model that is comes from learned capability and difficulty, not from a
    // reading of the goal's wording ("codebase" no longer implies "strong").
    const decided = listEventsForNode(db, root.id)
      .filter((e) => e.type === 'market.decision')
      .map((e) => e.payload as { role: string; model: string | null })
      .find((r) => r.role === 'execute')!;
    expect(calls[0].model ?? undefined).toBe(decided.model ?? undefined);
    // No children, so nothing to synthesise.
    expect(listNodes(db).filter((node) => node.parentId !== null)).toHaveLength(0);
  });

  it('completes a delegated parent on its children\'s verified work instead of redoing it alone', async () => {
    // opt rep 61 (seaborn): two children made and tested the fix, the parent
    // was judged on its own empty rows, failed, and re-ran the whole task
    // itself twice — 91 turns for a fix its children had already delivered.
    const db = createDb(TEST_DB);
    const calls: ExecuteStepInput[] = [];
    stub.mockImplementation(async (input: ExecuteStepInput) => {
      calls.push(input);
      const r = input.goal.includes('Split this goal')
        ? result(JSON.stringify(['Fix checkout error handling in src/cart/checkout.ts', 'Add tests for checkout in src/cart/checkout.test.ts']))
        : { succeeded: true, message: 'done', usage: { ...ZERO_USAGE }, events: successfulRunEvents({ editedPath: 'src/cart/checkout.ts', verifyCommand: 'npx vitest run src/cart' }) };
      r.events.forEach((event) => input.onEvent?.(event));
      return r;
    });
    const id = randomUUID();
    insertNode(db, {
      id, parentId: null, goal: GOAL, repoPath: tmpRepo(), state: 'CREATED', createdAt: 't0', updatedAt: 't0',
      contract: { goal: GOAL, definition_of_done: [GOAL], authority: { tools: [], spawn_children: true, max_child_count: 3, budget_usd: 10 }, constraints: [] },
    });
    insertDodItems(db, id, [GOAL], 't0', () => randomUUID());
    startNodeActor(db, id, GOAL);
    await vi.waitFor(() => expect(['COMPLETE', 'FAILED', 'CANCELLED']).toContain(getNode(db, id)?.state), { timeout: 10_000 });

    expect(getNode(db, id)?.state).toBe('COMPLETE');
    // Planning and the synthesis that merges the children's reports are the
    // parent's own jobs; re-running the task itself is not.
    const parentSelfRuns = calls.filter((c) => c.nodeId === id
      && !c.goal.includes('Split this goal') && !c.goal.startsWith('THE ORIGINAL GOAL'));
    expect(parentSelfRuns).toHaveLength(0);
  });

  it('still fans out, but no wider than the default cap', async () => {
    const db = createDb(TEST_DB);
    const five = JSON.stringify(['a', 'b', 'c', 'd', 'e']);
    await runDelegating(db, tmpRepo(), five);
    // max_child_count is 3 and the planner offered 5; the default cap of 2 is
    // the binding constraint on *breadth* — still only 2 workstream positions,
    // never the 5 the planner offered. This mock never produces evidence a
    // child's own validation accepts, so each position now also gets replaced
    // up to MAX_CHILD_ATTEMPTS times (delegate-child.ts) before giving up —
    // 2 positions x 3 attempts is the ceiling, not a third workstream.
    expect(listNodes(db).filter((node) => node.parentId !== null).length).toBeLessThanOrEqual(2 * 3);
  });

  it('selects the planner’s context whatever the retired efficiency switch says', async () => {
    // There is one production architecture; the old baseline switch is inert.
    process.env.ORG_EFFICIENCY_MODE = 'disabled';
    const calls = await runDelegating(createDb(TEST_DB), tmpRepo(), '[]');
    expect(calls[0].goal).toContain('Repository shape:');
    expect(calls[0].goal).not.toContain('unrelated.ts');
  });

  describe('when the market chose to split and the planner disagrees', () => {
    // The planner keeps its veto: it is the one judge that has looked at the
    // repository, and P(splits) is a judgment about the words (a single seaborn
    // bug report once scored 0.91). Its dispatch is priced either way.
    const isPlanning = (input: ExecuteStepInput) => input.goal.includes('Split this goal');

    it('honours [] and records that the delegation was not carried out', async () => {
      const db = createDb(TEST_DB);
      const calls = await runDelegating(db, tmpRepo(), '[]');
      const plan = calls.find(isPlanning)!;
      expect(plan).toBeDefined();
      // The planner's model is the market's decision, nothing else's: the
      // receipt for the plan dispatch names the model that ran.
      const receipt = listEventsForNode(db, listNodes(db).find((node) => node.parentId === null)!.id)
        .filter((e) => e.type === 'market.decision')
        .map((e) => e.payload as { role: string; model: string | null })
        .find((r) => r.role === 'plan')!;
      expect(plan.model ?? undefined).toBe(receipt.model ?? undefined);

      // And the record says what actually happened: no receipt or execution
      // plan claiming a delegation the node never carried out.
      const root = listNodes(db).find((node) => node.parentId === null)!;
      const events = listEventsForNode(db, root.id);
      expect(events.some((e) => e.type === 'delegation.declined')).toBe(true);
      const receipts = events.filter((e) => e.type === 'decision.receipt').map((e) => e.payload as { chosen: string; reason: string });
      expect(receipts.length).toBeGreaterThan(0);
      expect(receipts.every((r) => r.chosen !== 'SPAWN_AGENT')).toBe(true);
      expect(receipts[0].reason).toContain('delegation was chosen but not carried out');
      const steps = events.filter((e) => e.type === 'execution.plan')
        .flatMap((e) => (e.payload as { steps: { intent: string }[] }).steps.map((step) => step.intent));
      expect(steps).not.toContain('SPAWN_AGENT');
    });

    it('pins "does not split" so the same goal on the same tree does not buy a second planner', async () => {
      const db = createDb(TEST_DB);
      const repoPath = tmpRepo();
      const first = await runDelegating(db, repoPath, '[]');
      // Once per node: its validation retries do not re-plan either.
      expect(first.filter(isPlanning)).toHaveLength(1);
      const second = await runDelegating(db, repoPath, '[]');
      expect(second.filter(isPlanning)).toHaveLength(0);
    });

    it('runs an ordered plan in order, handing the later piece what the earlier one reported', async () => {
      const db = createDb(TEST_DB);
      const answer = JSON.stringify([
        'Fix checkout error handling in src/cart/checkout.ts',
        { goal: 'Add tests for checkout in src/cart/checkout.test.ts', after: [0] },
      ]);
      stub.mockImplementation(async (input: ExecuteStepInput) => {
        const r = isPlanning(input)
          ? result(answer)
          : { succeeded: true, message: 'done', usage: { ...ZERO_USAGE }, events: successfulRunEvents({ editedPath: 'src/cart/checkout.ts', verifyCommand: 'npx vitest run src/cart' }) };
        r.events.forEach((event) => input.onEvent?.(event));
        return r;
      });
      const id = randomUUID();
      insertNode(db, {
        id, parentId: null, goal: GOAL, repoPath: tmpRepo(), state: 'CREATED', createdAt: 't0', updatedAt: 't0',
        contract: { goal: GOAL, definition_of_done: [GOAL], authority: { tools: [], spawn_children: true, max_child_count: 3, budget_usd: 10 }, constraints: [] },
      });
      startNodeActor(db, id, GOAL);
      await vi.waitFor(() => expect(['COMPLETE', 'FAILED', 'CANCELLED']).toContain(getNode(db, id)?.state), { timeout: 10_000 });

      const children = listNodes(db).filter((node) => node.parentId === id);
      expect(children).toHaveLength(2);
      const dependent = children.find((node) => node.goal.startsWith('Add tests'))!;
      // Only readable once the first child finished: proof it waited.
      expect(dependent.goal).toContain('This piece builds on work already finished');
      expect(dependent.goal).toContain('Fix checkout error handling');
      const scheduled = listEventsForNode(db, id).find((e) => e.type === 'delegation.scheduled');
      expect((scheduled?.payload as { groups: string[][] }).groups).toEqual([['0'], ['1']]);
    });
  });
});
