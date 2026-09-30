import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb, type Db } from '../db/client.js';
import { insertNode } from '../db/queries/nodes.js';
import { listEventsForNode, appendEvent } from '../db/queries/events.js';
import { recordDispatchUsage } from '../db/queries/tokens.js';
import { ZERO_USAGE } from '../execution/tokens.js';
import { decideRecoveryFor, assignmentEconomicState } from './node-actor-manager.js';
import { MIN_AGENT_BUDGET_USD } from '../engines/decide-execution.js';
import type { RecoveryContext } from './delegate-child.js';
import type { DelegationRecord, ParentFeedback } from '../schemas/delegation.js';

const TEST_DB = './test-assignment-recovery.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const feedback = (check = 'npm test passes'): ParentFeedback => ({
  assignmentId: 'a1', revision: 5,
  failedChecks: [{ check, observed: 'no run', expected: 'green', evidenceRefs: [] }],
  requiredChanges: [], guidance: [], nextChecks: [check],
});

function context(earlier: ParentFeedback[] = []): RecoveryContext {
  const current = feedback();
  const assignment = {
    id: 'a1', parentId: 'parent', childId: 'kid', goal: 'Build the cart', definitionOfDone: [], acceptanceChecks: [],
    dependencies: [], status: 'FEEDBACK_REQUIRED', revision: 7, attempt: 1 + earlier.length, budgetUsd: 1,
    feedback: current, feedbackHistory: earlier, createdAt: 't', updatedAt: 't',
  } as DelegationRecord;
  return { assignment, feedback: current, reworks: earlier.length, run: { succeeded: true } };
}

function setup(childBudgetUsd = 1) {
  const db = createDb(TEST_DB);
  const contract = (budget: number) => ({
    goal: 'g', definition_of_done: ['d'],
    authority: { tools: [] as string[], spawn_children: false, max_child_count: 0, budget_usd: budget }, constraints: [] as string[],
  });
  insertNode(db, { id: 'parent', parentId: null, goal: 'p', contract: contract(6), state: 'DELEGATE', createdAt: 't', updatedAt: 't' });
  insertNode(db, { id: 'kid', parentId: 'parent', goal: 'Build the cart', contract: contract(childBudgetUsd), state: 'COMPLETE', createdAt: 't', updatedAt: 't' });
  return db;
}

/** What a child spent: token usage, and the `result` event that carries its dollars
 *  (the same source the budget meter reads). */
const spend = (db: Db, tokens: number, costUsd: number) => {
  recordDispatchUsage(db, {
    nodeId: 'kid', role: 'execute', model: null, costUsd, createdAt: new Date().toISOString(),
    usage: { ...ZERO_USAGE, inputTokens: tokens - 1_000, outputTokens: 1_000 },
  });
  appendEvent(db, { nodeId: 'kid', type: 'exec.result', payload: { total_cost_usd: costUsd, session_id: 's1' }, createdAt: new Date().toISOString() });
};

const decisions = (db: Db) => listEventsForNode(db, 'parent').filter((e) => e.type === 'recovery.assignment_decided');

describe('the production recovery governor', () => {
  it('will not fund another revision the child cannot afford, whatever the market might say', () => {
    const db = setup(MIN_AGENT_BUDGET_USD / 2);
    const decision = decideRecoveryFor(db, context());
    expect(decision.action).toBe('escalate');
    expect(decisions(db)).toHaveLength(0); // the floor answered; the market was not consulted
  });

  it('defers to the default — the same child, reworked — when nothing has been measured about it', () => {
    const db = setup();
    expect(decideRecoveryFor(db, context())).toEqual({ action: 'rework' });
    expect(decisions(db)[0].payload).toMatchObject({
      assignmentId: 'a1', childId: 'kid', action: 'rework', reasonCodes: expect.arrayContaining(['market:no_measurement']),
    });
  });

  it('reads the child\'s own spend, in tokens and in dollars, into the state the market prices', () => {
    const db = setup(2);
    spend(db, 80_000, 0.4);
    const state = assignmentEconomicState(db, 'kid', 'Build the cart');
    expect(state.resources.consumedTokens).toBe(80_000);
    expect(state.resources).toMatchObject({ budgetUsd: 2, spentUsd: 0.4 });
    expect(state.resources.usdPerToken).toBeCloseTo(0.4 / 80_000, 10);
  });

  it('leaves no trace of having asked: it is a question, not a boundary', () => {
    const db = setup();
    spend(db, 80_000, 0.4);
    const first = assignmentEconomicState(db, 'kid', 'Build the cart');
    const second = assignmentEconomicState(db, 'kid', 'Build the cart');
    expect(second.trajectory).toEqual(first.trajectory);
  });

  it('once the same checks keep being refused, it does not send the same child round again', () => {
    const db = setup(3);
    spend(db, 60_000, 0.36);
    const decision = decideRecoveryFor(db, context([feedback(), feedback()]));
    // Reworking the same way a third time is refused; what replaces it is the
    // market's call — a fresh owner if that is cheap, otherwise stop and ask.
    expect(decision.action).not.toBe('rework');
    if (decision.action === 'reassign') {
      expect(decision.decidedBy).toMatch(/^market:/);
      expect(decision.reason).toMatch(/refused 3 times/);
    }
  });

  it('records every decision against the parent, with what the market considered', () => {
    const db = setup(3);
    spend(db, 60_000, 0.36);
    const decision = decideRecoveryFor(db, context([feedback(), feedback()]));
    const [event] = decisions(db);
    expect(event.nodeId).toBe('parent');
    expect(event.payload).toMatchObject({
      assignmentId: 'a1', parentId: 'parent', childId: 'kid', action: decision.action,
      sameFailureBefore: 2, failureSignature: expect.stringContaining('npm test passes'),
    });
    expect((event.payload as { decisionId: string }).decisionId).toMatch(/^assignment-a1-7$|^dec-/);
    expect(Array.isArray((event.payload as { reasonCodes: unknown }).reasonCodes)).toBe(true);
  });

  it('never returns anything but a way of continuing or stopping', () => {
    for (const earlier of [0, 1, 2, 3]) {
      const db = setup(3);
      spend(db, 60_000, 0.36);
      const { action } = decideRecoveryFor(db, context(Array.from({ length: earlier }, () => feedback())));
      expect(['rework', 'reassign', 'escalate']).toContain(action);
      unlinkSync(TEST_DB);
      for (const suffix of ['-journal', '-wal', '-shm']) if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
    }
  });
});
