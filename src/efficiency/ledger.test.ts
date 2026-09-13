import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createDb } from '../db/client.js';
import { memory } from '../db/schema.js';
import { createEfficiencyLedger, loadEfficiencyRecords, EFFICIENCY_EVENT } from './ledger.js';
import { subscribeAll } from '../events/bus.js';
import { ZERO_USAGE } from '../execution/tokens.js';

const usage = (input: number, output: number, cacheRead = 0) => ({
  ...ZERO_USAGE, inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead,
});

/** A clock the test drives, so elapsed time is asserted rather than slept for. */
function fakeClock(start = 1000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('efficiency ledger', () => {
  it('sums dispatches into one terminal record', () => {
    const clock = fakeClock();
    const ledger = createEfficiencyLedger(clock.now);
    ledger.startTask('n1');
    ledger.recordDispatch('n1', { role: 'plan', usage: usage(500, 100), costUsd: 0.01, ms: 2000 });
    clock.advance(2000);
    ledger.recordDispatch('n1', { role: 'execute', usage: usage(3000, 900), costUsd: 0.2, ms: 8000 });
    clock.advance(8000);

    const record = ledger.finishTask('n1', 'success');
    expect(record.totalTokens).toBe(4500);
    expect(record.planningCalls).toBe(1);
    expect(record.executionCalls).toBe(1);
    expect(record.dispatchMs).toBe(10_000);
    expect(record.endToEndMs).toBe(10_000);
    expect(record.costUsd).toBeCloseTo(0.21);
  });

  it('attributes plan and synthesize spend to coordination', () => {
    const ledger = createEfficiencyLedger(fakeClock().now);
    ledger.startTask('n1');
    ledger.recordDispatch('n1', { role: 'plan', usage: usage(500, 100), costUsd: 0, ms: 0 });
    ledger.recordDispatch('n1', { role: 'execute', usage: usage(3000, 900), costUsd: 0, ms: 0 });
    ledger.recordDispatch('n1', { role: 'synthesize', usage: usage(400, 200), costUsd: 0, ms: 0 });

    const record = ledger.finishTask('n1', 'success');
    expect(record.coordinationTokens).toBe(1200);
    expect(record.totalTokens).toBe(5100);
  });

  it('attributes a superseded attempt to recovery, not to fresh work', () => {
    const ledger = createEfficiencyLedger(fakeClock().now);
    ledger.startTask('n1');
    ledger.recordDispatch('n1', { role: 'execute', usage: usage(100, 10), costUsd: 0, ms: 0 });
    ledger.recordDispatch('n1', { role: 'execute', usage: usage(3000, 900), costUsd: 0, ms: 0, superseded: true });

    const record = ledger.finishTask('n1', 'success');
    expect(record.retries).toBe(1);
    expect(record.recoveryTokens).toBe(3900);
  });

  it('counts the dispatches that never happened', () => {
    const ledger = createEfficiencyLedger(fakeClock().now);
    ledger.startTask('n1');
    ledger.recordAvoided('n1', 'plan');
    ledger.recordAvoided('n1', 'synthesize');

    const record = ledger.finishTask('n1', 'success');
    expect(record.avoidedPlanningCalls).toBe(1);
    expect(record.avoidedSynthesisCalls).toBe(1);
    expect(record.synthesisAvoidanceRatio).toBe(1);
  });

  it('counts a reused execution and what it saved', () => {
    const ledger = createEfficiencyLedger(fakeClock().now);
    ledger.startTask('n1');
    // The tokens the reused dispatch cost when it was first paid for. Recorded
    // as avoided rather than spent: the whole sandbox did not run.
    ledger.recordAvoided('n1', 'execute', 1_772_218);

    const record = ledger.finishTask('n1', 'success');
    expect(record.avoidedExecutionCalls).toBe(1);
    expect(record.tokensAvoided).toBe(1_772_218);
    expect(record.totalTokens).toBe(0);
    expect(record.workAvoidedRatio).toBe(1);
  });

  it('records queue and startup time separately from dispatch time', () => {
    const ledger = createEfficiencyLedger(fakeClock().now);
    ledger.startTask('n1');
    ledger.recordDispatch('n1', { role: 'execute', usage: usage(10, 10), costUsd: 0, ms: 500, queuedMs: 1500, startupMs: 120 });

    const record = ledger.finishTask('n1', 'success');
    // Waiting for a slot, waiting for a container, and working are three
    // different things with three different fixes.
    expect(record.queueMs).toBe(1500);
    expect(record.startupMs).toBe(120);
    expect(record.dispatchMs).toBe(500);
    expect(record.executionOverheadRatio).toBeCloseTo(120 / 500);
  });

  it('publishes exactly one terminal event per task', () => {
    const ledger = createEfficiencyLedger(fakeClock().now);
    const seen: unknown[] = [];
    const stop = subscribeAll((event) => { if (event.type === EFFICIENCY_EVENT) seen.push(event.payload); });
    try {
      ledger.startTask('n-publish');
      ledger.recordDispatch('n-publish', { role: 'execute', usage: usage(10, 5), costUsd: 0, ms: 1 });
      ledger.finishTask('n-publish', 'success');
    } finally {
      stop();
    }
    expect(seen).toHaveLength(1);
    expect((seen[0] as { totalTokens: number }).totalTokens).toBe(15);
  });

  it('forgets a task once it is finished, so a long-lived daemon does not grow', () => {
    const ledger = createEfficiencyLedger(fakeClock().now);
    ledger.startTask('n1');
    ledger.recordDispatch('n1', { role: 'execute', usage: usage(100, 100), costUsd: 0, ms: 0 });
    ledger.finishTask('n1', 'success');
    expect(ledger.size()).toBe(0);

    // A second finish for the same id reports an empty run rather than
    // resurrecting the first one's totals.
    expect(ledger.finishTask('n1', 'success').totalTokens).toBe(0);
  });

  it('never throws on a task that was never started', () => {
    const ledger = createEfficiencyLedger(fakeClock().now);
    expect(() => ledger.recordDispatch('ghost', { role: 'execute', usage: usage(5, 5), costUsd: 0, ms: 0 })).not.toThrow();
    const record = ledger.finishTask('ghost', 'failure');
    // The dispatch is still counted: telemetry that silently drops data is
    // worse than telemetry with an approximate start time.
    expect(record.totalTokens).toBe(10);
    expect(record.outcome).toBe('failure');
  });

  it('reports cache reads without adding them to the total', () => {
    const ledger = createEfficiencyLedger(fakeClock().now);
    ledger.startTask('n1');
    ledger.recordDispatch('n1', { role: 'execute', usage: usage(1000, 100, 800), costUsd: 0, ms: 0 });
    const record = ledger.finishTask('n1', 'success');
    expect(record.totalTokens).toBe(1100);
    expect(record.cachedTokens).toBe(800);
    expect(record.cacheHitRatio).toBeCloseTo(0.8);
  });

  it('survives a publisher that throws', () => {
    const ledger = createEfficiencyLedger(fakeClock().now, () => { throw new Error('bus down'); });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      ledger.startTask('n1');
      expect(() => ledger.finishTask('n1', 'success')).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('loadEfficiencyRecords', () => {
  const DB = './test-efficiency-records.db';
  afterEach(() => {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      if (existsSync(DB + suffix)) unlinkSync(DB + suffix);
    }
  });

  it('reads back the records a run stored, and skips rows it cannot read', () => {
    const db = createDb(DB);
    const record = createEfficiencyLedger(fakeClock().now).finishTask('n1', 'success');
    // `value` is NOT NULL in the schema, so a null row cannot exist — a row
    // whose shape we do not recognise is the realistic bad case.
    for (const value of [record, { rubbish: true }]) {
      db.insert(memory).values({
        id: randomUUID(), kind: 'efficiency_record', key: 'n1', value,
        confidence: null, nodeId: 'n1', createdAt: new Date().toISOString(),
      }).run();
    }
    const loaded = loadEfficiencyRecords(db);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].taskId).toBe('n1');
  });
});

describe('optimization attribution', () => {
  it('records what the planner chose, accumulating across dispatches', () => {
    const ledger = createEfficiencyLedger(() => 0, () => {});
    ledger.startTask('t');
    ledger.recordContextPlan('t', { candidates: 40, selected: 5, estimatedTokens: 600, contextPolicyVersion: 'ctx-1', executionPolicyVersion: 'exec-1' });
    ledger.recordContextPlan('t', { candidates: 40, selected: 3, estimatedTokens: 400, contextPolicyVersion: 'ctx-1' });

    const record = ledger.finishTask('t', 'success');
    // Both handovers were really paid for, so both are counted.
    expect(record.contextCandidates).toBe(80);
    expect(record.contextSelected).toBe(8);
    expect(record.contextEstimatedTokens).toBe(1000);
    expect(record.contextPolicyVersion).toBe('ctx-1');
    expect(record.executionPolicyVersion).toBe('exec-1');
  });

  it('keeps the last trajectory reading, not every one it passed through', () => {
    const ledger = createEfficiencyLedger(() => 0, () => {});
    ledger.startTask('t');
    ledger.recordTrajectory('t', { exploration: 0.9, progress: 0.1 });
    ledger.recordTrajectory('t', { exploration: 0.3, progress: 0.8 });

    const record = ledger.finishTask('t', 'success');
    expect(record.explorationSignal).toBe(0.3);
    expect(record.progressSignal).toBe(0.8);
  });

  it('records why a task was stopped, and leaves it null when nothing stopped it', () => {
    const stopped = createEfficiencyLedger(() => 0, () => {});
    stopped.startTask('t');
    stopped.recordStop('t', 'Spend cap reached — $1.25 of $1.00.');
    expect(stopped.finishTask('t', 'budget_exhausted').stopReason).toMatch(/Spend cap/);

    const finished = createEfficiencyLedger(() => 0, () => {});
    finished.startTask('t');
    expect(finished.finishTask('t', 'success').stopReason).toBeNull();
  });

  it('sums turns across dispatches — the term whose cost grows superlinearly', () => {
    const ledger = createEfficiencyLedger(() => 0, () => {});
    ledger.startTask('t');
    ledger.recordDispatch('t', { role: 'execute', usage: { ...ZERO_USAGE, numTurns: 19 }, costUsd: 0.5, ms: 1 });
    ledger.recordDispatch('t', { role: 'execute', usage: { ...ZERO_USAGE, numTurns: 42 }, costUsd: 0.9, ms: 1 });
    expect(ledger.finishTask('t', 'success').turns).toBe(61);
  });

  it('reports the acceptance metrics per success, and null on a failure', () => {
    const ok = createEfficiencyLedger(() => 0, () => {});
    ok.startTask('t');
    ok.recordDispatch('t', { role: 'execute', usage: { ...ZERO_USAGE, inputTokens: 100, cacheReadTokens: 5000, numTurns: 12 }, costUsd: 0.4, ms: 1 });
    const success = ok.finishTask('t', 'success');
    expect(success.costPerSuccessfulTask).toBeCloseTo(0.4);
    expect(success.turnsPerSuccessfulTask).toBe(12);
    expect(success.cacheReadPerSuccessfulTask).toBe(5000);

    const bad = createEfficiencyLedger(() => 0, () => {});
    bad.startTask('t');
    bad.recordDispatch('t', { role: 'execute', usage: { ...ZERO_USAGE, numTurns: 12 }, costUsd: 0.4, ms: 1 });
    const failure = bad.finishTask('t', 'failure');
    // A failure has no cost-per-success to contribute, and averaging a zero in
    // would make failing look cheap.
    expect(failure.costPerSuccessfulTask).toBeNull();
    expect(failure.turnsPerSuccessfulTask).toBeNull();
  });
});
