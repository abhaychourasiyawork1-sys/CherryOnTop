/** Accumulates what a task spent, dispatch by dispatch, and emits one record
 *  when it ends.
 *
 *  Accounting, and only accounting — the same contract `recordUsage` in
 *  node-actor-manager.ts already holds. Every method is total: a task that was
 *  never started still records, a bus that refuses the terminal event still
 *  returns the record. A run must never fail because measuring it did. */
import type { DispatchUsage } from '../execution/tokens.js';
import { publish, type BusEvent } from '../events/bus.js';
import {
  buildEfficiencyRecord, EMPTY_TOTALS,
  type EfficiencyOutcome, type EfficiencyRecord,
} from './metrics.js';

export const EFFICIENCY_EVENT = 'efficiency.record';

/** The three dispatch kinds, matching `DispatchRole` in config/efficiency.ts —
 *  the same roles `org tokens` already groups by. */
export type LedgerRole = 'plan' | 'execute' | 'synthesize';

export interface LedgerDispatch {
  role: LedgerRole;
  usage: DispatchUsage;
  costUsd: number;
  /** Wall-clock inside the dispatch itself. */
  ms: number;
  /** Wall-clock spent waiting for a sandbox slot before it. */
  queuedMs?: number;
  /** This dispatch was thrown away and re-run — the model-fallback retry. Its
   *  tokens bought nothing, so they are recovery spend rather than work. */
  superseded?: boolean;
}

export interface EfficiencyLedger {
  startTask(taskId: string): void;
  recordDispatch(taskId: string, dispatch: LedgerDispatch): void;
  /** A dispatch the efficiency work prevented: a plan-cache hit, a synthesis
   *  made unnecessary by a single complete child. */
  recordAvoided(taskId: string, role: 'plan' | 'synthesize'): void;
  finishTask(taskId: string, outcome: EfficiencyOutcome, qualityScore?: number | null): EfficiencyRecord;
  /** How many tasks are still open. Exists so a leak is a failing test rather
   *  than a slow memory climb in a daemon that runs for weeks. */
  size(): number;
}

type Totals = typeof EMPTY_TOTALS;
interface OpenTask { startedMs: number; totals: Totals }

function openTask(nowMs: number): OpenTask {
  return { startedMs: nowMs, totals: { ...EMPTY_TOTALS } };
}

export function createEfficiencyLedger(
  now: () => number = Date.now,
  emit: (event: BusEvent) => void = publish,
): EfficiencyLedger {
  const open = new Map<string, OpenTask>();
  // A dispatch can arrive for a task nobody started — a code path that
  // dispatches before the state machine opened the task, or a test. Counting it
  // against an approximate start time beats dropping the numbers.
  const taskFor = (taskId: string): OpenTask => {
    let task = open.get(taskId);
    if (!task) { task = openTask(now()); open.set(taskId, task); }
    return task;
  };

  return {
    startTask(taskId) {
      open.set(taskId, openTask(now()));
    },

    recordDispatch(taskId, dispatch) {
      const t = taskFor(taskId).totals as Record<string, number>;
      const { usage } = dispatch;
      const tokens = usage.inputTokens + usage.outputTokens;

      t.inputTokens += usage.inputTokens;
      t.outputTokens += usage.outputTokens;
      // Cache creation is billed as input and is already inside inputTokens;
      // only the *read* is the saving worth reporting.
      t.cachedTokens += usage.cacheReadTokens;
      t.costUsd += dispatch.costUsd;
      t.dispatchMs += dispatch.ms;
      t.queueMs += dispatch.queuedMs ?? 0;

      if (dispatch.role === 'plan') t.planningCalls += 1;
      else if (dispatch.role === 'execute') t.executionCalls += 1;
      else t.synthesisCalls += 1;

      // Slices of the same input/output counted above — never added to it.
      if (dispatch.role !== 'execute') t.coordinationTokens += tokens;
      if (dispatch.superseded) { t.retries += 1; t.recoveryTokens += tokens; }
    },

    recordAvoided(taskId, role) {
      const t = taskFor(taskId).totals as Record<string, number>;
      if (role === 'plan') t.avoidedPlanningCalls += 1;
      else t.avoidedSynthesisCalls += 1;
    },

    finishTask(taskId, outcome, qualityScore = null) {
      const task = open.get(taskId) ?? openTask(now());
      open.delete(taskId);

      const record = buildEfficiencyRecord({
        ...task.totals,
        taskId,
        outcome,
        qualityScore,
        endToEndMs: Math.max(0, now() - task.startedMs),
      });

      try {
        emit({
          nodeId: taskId,
          type: EFFICIENCY_EVENT,
          payload: record,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error(`Failed to publish the efficiency record for ${taskId}:`, err);
      }
      return record;
    },

    size: () => open.size,
  };
}

/** The daemon-wide ledger. One per process, like the sandbox limiter, because
 *  the thing being measured is one organization's spend and not one node's. */
let shared: EfficiencyLedger | null = null;

export function efficiencyLedger(): EfficiencyLedger {
  shared ??= createEfficiencyLedger();
  return shared;
}
