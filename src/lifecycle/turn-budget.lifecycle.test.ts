/** D2 through the real lifecycle (bench/governor/h26/DESIGN.md §2): the
 *  failure the 2026-10-02 Arm B run found — a first dispatch spending the whole
 *  task turn budget, so the retry was hard-stopped before the boundary ran —
 *  cannot happen with the retry reservation on, and nothing changes with it off. */
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
const { insertDodItems } = await import('../db/queries/dod.js');
const { listEventsForNode } = await import('../db/queries/events.js');
const { startNodeActor } = await import('./node-actor-manager.js');
const { executeStep } = await import('../execution/execute-step.js');
const { ZERO_USAGE, usageFromEvents } = await import('../execution/tokens.js');
const { replayInto, successfulRunEvents } = await import('./run-fixtures.js');
import type { ExecuteStepInput } from '../execution/execute-step.js';

const stub = executeStep as unknown as Mock;
const TEST_DB = './test-turn-budget-lifecycle.db';
const GOAL = 'requests.get always sends a Content-Length header, which breaks some servers. GET requests should not add Content-Length automatically; update the models and the adapters so they stop doing it.';
const saved = { ...process.env };

beforeEach(() => { process.env.ORG_MAX_TURNS_EXECUTE = '80'; });
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  for (const k of ['ORG_MAX_TURNS_EXECUTE', 'ORG_TURN_RETRY_RESERVATION']) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  vi.clearAllMocks();
});

function repo(): string {
  const path = mkdtempSync(join(tmpdir(), 'turn-budget-'));
  writeFileSync(join(path, 'models.py'), 'x = 1\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '-A'); git('commit', '-qm', 'x');
  return path;
}

/** What Claude Code does with `--max-turns cap` for an agent that wants
 *  `want` turns: min(cap, want) model calls, then a result — on the cap,
 *  `error_max_turns` reporting `num_turns` one higher than it ran (measured,
 *  2026-10-02). Usage is parsed by the production `usageFromEvents`. */
function cliDispatch(cap: number | undefined, want: number, tokensPerTurn = 6_000) {
  const ran = cap === undefined ? want : Math.min(cap, want);
  const hitCap = cap !== undefined && want > cap;
  const events = [
    ...Array.from({ length: ran }, (_, i) => ({ type: 'assistant', payload: { message: { id: `msg_${i}`, usage: { input_tokens: tokensPerTurn } } } })),
    { type: 'result', payload: { subtype: hitCap ? 'error_max_turns' : 'success', num_turns: hitCap ? ran + 1 : ran, usage: { input_tokens: ran * tokensPerTurn } } },
  ];
  return { ran, hitCap, usage: usageFromEvents(events) };
}

/** Every attempt wants more turns than any cap: it spends its whole cap. */
async function runSpendingEveryTurn(executed: number[] = [], tokensPerTurn = 6_000): Promise<{ calls: ExecuteStepInput[]; id: string; db: ReturnType<typeof createDb> }> {
  const calls: ExecuteStepInput[] = [];
  stub.mockImplementation(async (input: ExecuteStepInput) => {
    calls.push(input);
    const run = cliDispatch(input.maxTurns, 1_000, tokensPerTurn);
    executed.push(run.ran);
    return replayInto(input, {
      succeeded: false, message: 'error_max_turns',
      // ~6k tokens a turn, the rate the Arm B runs measured.
      usage: { ...ZERO_USAGE, ...run.usage },
      events: successfulRunEvents({ editedPath: 'models.py' }),
    });
  });
  const db = createDb(TEST_DB);
  const id = randomUUID();
  insertNode(db, {
    id, parentId: null, goal: GOAL, repoPath: repo(), state: 'CREATED', createdAt: 't0', updatedAt: 't0',
    contract: { goal: GOAL, definition_of_done: [GOAL], authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 0 }, constraints: [] },
  });
  insertDodItems(db, id, [GOAL], 't0', () => randomUUID());
  startNodeActor(db, id, GOAL);
  await vi.waitFor(() => expect(getNode(db, id)?.state).toMatch(/COMPLETE|FAILED/), { timeout: 15_000 });
  return { calls, id, db };
}

describe('D2 in the lifecycle', () => {
  it('off (the default): unchanged — the first dispatch gets the whole budget and leaves no retry', async () => {
    const { calls } = await runSpendingEveryTurn();
    expect(calls[0].maxTurns).toBe(80);
    expect(calls).toHaveLength(1);
  });

  it('on: the first dispatch is capped at T − R, and the retry still runs with the reservation', async () => {
    process.env.ORG_TURN_RETRY_RESERVATION = 'on';
    const { calls, id, db } = await runSpendingEveryTurn();
    expect(calls[0].maxTurns).toBe(60);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // The reservation reaches the retry (its D2 cap is R = 20); the retry may
    // cap itself lower by its own rules (a proof-only pass runs at most
    // PROOF_PASS_TURNS), never higher.
    expect(calls[1].maxTurns).toBeGreaterThan(0);
    expect(calls[1].maxTurns).toBeLessThanOrEqual(20);
    const budget = listEventsForNode(db, id).filter((e) => e.type === 'dispatch.turn_budget').map((e) => e.payload as { dispatchIndex: number; cap: number; T: number; R: number });
    expect(budget[0]).toMatchObject({ dispatchIndex: 1, cap: 60, T: 80, R: 20 });
    expect(budget[1]).toMatchObject({ dispatchIndex: 2, cap: 20 });
    // Never a dispatch beyond T: the task stops once the budget is spent.
    expect(calls.reduce((s, c) => s + (c.maxTurns ?? 0), 0)).toBeLessThanOrEqual(80);
  });

  it('on: executed turns obey D2 exactly (T = 80, R = 20) despite the CLI reporting cap + 1', async () => {
    process.env.ORG_TURN_RETRY_RESERVATION = 'on';
    const executed: number[] = [];
    const { calls, id, db } = await runSpendingEveryTurn(executed);
    // First dispatch: the CLI was given T − R and ran exactly that many turns.
    expect(calls[0].maxTurns).toBe(60);
    expect(executed[0]).toBe(60);
    // Every dispatch stays within the cap it was given.
    calls.forEach((c, i) => expect(executed[i]).toBeLessThanOrEqual(c.maxTurns!));
    const budget = listEventsForNode(db, id).filter((e) => e.type === 'dispatch.turn_budget')
      .map((e) => e.payload as { dispatchIndex: number; cap: number; turnsUsedBefore: number });
    // The retry sees the 60 turns that ran, not the 61 reported, so the whole
    // reservation R = 20 reaches it.
    expect(budget[1]).toMatchObject({ dispatchIndex: 2, turnsUsedBefore: 60, cap: 20 });
    // Multi-dispatch: the task never executes more than T turns in total, and
    // with none left no further sandbox is opened (cap 0 is a hard stop).
    expect(executed.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(80);
    for (const b of budget.slice(2)) expect(b.cap).toBe(0);
    expect(calls.length).toBe(budget.filter((b) => b.cap > 0).length);
  });

  it('on: the token-budget veto (DESIGN §2, option A) — D2 reserves turns, and a retry the market cannot fund stops before any boundary', async () => {
    process.env.ORG_TURN_RETRY_RESERVATION = 'on';
    // A cheap first dispatch: the turn-scaled token budget left after it
    // (R × measured tokens/turn) is far below a dispatch's reservation.
    const executed: number[] = [];
    const { calls, id, db } = await runSpendingEveryTurn(executed, 170);
    expect(executed).toEqual([60]);
    expect(calls).toHaveLength(1);
    const events = listEventsForNode(db, id);
    const blockedAt = events.findIndex((e) => e.type === 'step.outcome' && /No execution candidate is feasible/.test(String((e.payload as { message?: string }).message)));
    expect(blockedAt).toBeGreaterThan(-1);
    // Refused at execution selection, which precedes the D2 cap and the
    // economic boundary: no second turn budget, no boundary after it — so no
    // b* and no assignment can follow, in either experiment arm.
    const after = events.slice(blockedAt);
    expect(events.filter((e) => e.type === 'dispatch.turn_budget')).toHaveLength(1);
    expect(after.some((e) => e.type === 'economic.decision' || e.type.startsWith('experiment.'))).toBe(false);
  });
});
