/** Accumulates what a task spent, dispatch by dispatch, and emits one record
 *  when it ends.
 *
 *  Accounting, and only accounting — the same contract `recordUsage` in
 *  node-actor-manager.ts already holds. Every method is total: a task that was
 *  never started still records, a bus that refuses the terminal event still
 *  returns the record. A run must never fail because measuring it did. */
import type { DispatchUsage } from '../execution/tokens.js';
import { publish, type BusEvent } from '../events/bus.js';
import { listMemory } from '../db/queries/memory.js';
import type { Db } from '../db/client.js';
import {
  buildEfficiencyRecord, EMPTY_TOTALS, EMPTY_ATTRIBUTION,
  type EconomicDecisionLedgerEntry, type EfficiencyOutcome, type EfficiencyRecord,
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
  /** Wall-clock inside the dispatch spent before the runtime said anything:
   *  scheduling, image pull, container start, agent boot. A slice of `ms`. */
  startupMs?: number;
  /** This dispatch was thrown away and re-run — the model-fallback retry. Its
   *  tokens bought nothing, so they are recovery spend rather than work. */
  superseded?: boolean;
}

export interface EfficiencyLedger {
  startTask(taskId: string): void;
  recordDispatch(taskId: string, dispatch: LedgerDispatch): void;
  /** A dispatch the efficiency work prevented: a plan-cache hit, a synthesis
   *  made unnecessary by a single complete child, an execution served from a
   *  previous identical run. `tokensAvoided` is what that dispatch cost when it
   *  was last actually paid for — known only for a reused result, which is the
   *  only case where a real prior measurement exists to quote. */
  recordAvoided(taskId: string, role: 'plan' | 'synthesize' | 'execute', tokensAvoided?: number): void;
  /** What the optimizer decided for this task, and what deciding cost.
   *
   *  Separate from `recordDispatch` because it is not a dispatch: it happens
   *  once per task, before the money is spent, and recording it as spend would
   *  make the optimization look like the work. Called more than once — a task
   *  with a plan dispatch and an execute dispatch plans context twice — and the
   *  counters accumulate, because both handovers were really paid for. */
  recordContextPlan(taskId: string, plan: {
    candidates: number;
    selected: number;
    estimatedTokens: number;
    contextPolicyVersion?: string | null;
    executionPolicyVersion?: string | null;
    overheadUsd?: number;
  }): void;
  /** How the run was going when it last passed the guard, and why it stopped if
   *  something stopped it. Last value wins: what matters is the state the task
   *  ended in, not every state it passed through. */
  recordTrajectory(taskId: string, trajectory: { exploration: number; progress: number }): void;
  recordStop(taskId: string, reason: string): void;
  /** What the control plane decided, and what it expected that to do.
   *
   *  Recorded when the decision is *made*, before anything is known about how it
   *  went — which is the only point at which a prediction is a prediction
   *  rather than a description. Pure bookkeeping in memory: this is called on
   *  the path to a dispatch and must never touch a database. */
  recordDecision(taskId: string, entry: EconomicDecisionLedgerEntry): void;
  /** What actually happened, matched to the decision that expected it.
   *
   *  Separate call because the outcome arrives later, and often never — a
   *  decision nobody checked stays unreconciled rather than being credited with
   *  a zero. */
  reconcileDecision(taskId: string, decisionId: string, actual: NonNullable<EconomicDecisionLedgerEntry['actual']>): void;
  /** Tokens paid more than once for the same information. */
  recordDuplication(taskId: string, tokens: number): void;
  /** What stored knowledge saved, net of retrieving and verifying it. May be
   *  negative — memory that did not pay for itself is the result worth seeing. */
  recordMemoryValue(taskId: string, netValue: number): void;
  /** Tokens spent on each kind of work the control plane budgets separately. */
  recordSpend(taskId: string, bucket: 'evidence' | 'validation' | 'exploration', tokens: number): void;
  /** Every decision recorded for a task, in the order made. Exists so a
   *  benchmark can attribute a regression to specific decisions rather than to
   *  an aggregate. */
  decisions(taskId: string): EconomicDecisionLedgerEntry[];
  finishTask(taskId: string, outcome: EfficiencyOutcome, qualityScore?: number | null): EfficiencyRecord;
  /** How many tasks are still open. Exists so a leak is a failing test rather
   *  than a slow memory climb in a daemon that runs for weeks. */
  size(): number;
}

type Totals = typeof EMPTY_TOTALS;
type Attribution = typeof EMPTY_ATTRIBUTION;
interface OpenTask {
  startedMs: number;
  totals: Totals;
  attribution: Attribution;
  /** By decision id, so a reconciliation that arrives out of order still finds
   *  its prediction. */
  decisions: Map<string, EconomicDecisionLedgerEntry>;
}

function openTask(nowMs: number): OpenTask {
  return {
    startedMs: nowMs,
    totals: { ...EMPTY_TOTALS },
    attribution: { ...EMPTY_ATTRIBUTION },
    decisions: new Map(),
  };
}

/** How much better a decision expected to do than it did.
 *
 *  **Prediction error, not counterfactual regret.** True regret compares the
 *  choice against the best alternative, and nothing observed the alternative —
 *  manufacturing one would be inventing the very number the ledger exists to
 *  stop being invented. Positive means the decision over-promised. */
function predictionError(entry: EconomicDecisionLedgerEntry): number {
  if (!entry.actual) return 0;
  return entry.predicted.tokenDelta - entry.actual.tokenDelta;
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
      t.turns += usage.numTurns;
      t.dispatchMs += dispatch.ms;
      t.queueMs += dispatch.queuedMs ?? 0;
      t.startupMs += dispatch.startupMs ?? 0;

      if (dispatch.role === 'plan') t.planningCalls += 1;
      else if (dispatch.role === 'execute') t.executionCalls += 1;
      else t.synthesisCalls += 1;

      // Slices of the same input/output counted above — never added to it.
      if (dispatch.role !== 'execute') t.coordinationTokens += tokens;
      if (dispatch.superseded) { t.retries += 1; t.recoveryTokens += tokens; }
    },

    recordAvoided(taskId, role, tokensAvoided = 0) {
      const t = taskFor(taskId).totals as Record<string, number>;
      if (role === 'plan') t.avoidedPlanningCalls += 1;
      else if (role === 'execute') t.avoidedExecutionCalls += 1;
      else t.avoidedSynthesisCalls += 1;
      t.tokensAvoided += Math.max(0, tokensAvoided);
    },

    recordContextPlan(taskId, plan) {
      const task = taskFor(taskId);
      const t = task.totals as Record<string, number>;
      t.contextCandidates += Math.max(0, plan.candidates);
      t.contextSelected += Math.max(0, plan.selected);
      t.contextEstimatedTokens += Math.max(0, plan.estimatedTokens);
      t.optimizationOverheadUsd += Math.max(0, plan.overheadUsd ?? 0);
      if (plan.contextPolicyVersion) task.attribution.contextPolicyVersion = plan.contextPolicyVersion;
      if (plan.executionPolicyVersion) task.attribution.executionPolicyVersion = plan.executionPolicyVersion;
    },

    recordTrajectory(taskId, trajectory) {
      const t = taskFor(taskId).totals as Record<string, number>;
      t.explorationSignal = trajectory.exploration;
      t.progressSignal = trajectory.progress;
    },

    recordStop(taskId, reason) {
      taskFor(taskId).attribution.stopReason = reason;
    },

    recordDecision(taskId, entry) {
      const task = taskFor(taskId);
      const t = task.totals as Record<string, number>;
      // A decision already recorded is the same decision, not a second one: the
      // boundary can be reached twice for one cycle, and counting it twice
      // would inflate the denominator of every rate below.
      if (task.decisions.has(entry.decisionId)) return;
      task.decisions.set(entry.decisionId, { ...entry });
      t.decisionCycles += 1;
      if (entry.action !== 'continue') t.interventions += 1;
      t.orchestrationTokens += Math.max(0, entry.orchestrationCost);
    },

    reconcileDecision(taskId, decisionId, actual) {
      const task = taskFor(taskId);
      const entry = task.decisions.get(decisionId);
      // A reconciliation for a decision this ledger never saw is not an error —
      // a daemon restart loses the open task, not the run — but it must not
      // invent a prediction to match it.
      if (!entry || entry.actual) return;
      entry.actual = { ...actual };
      entry.regret = predictionError(entry);

      const t = task.totals as Record<string, number>;
      if (entry.action !== 'continue') {
        t.reconciledInterventions += 1;
        if (actual.tokenDelta > 0) t.beneficialInterventions += 1;
      }
      t.totalRegret += entry.regret;
    },

    recordDuplication(taskId, tokens) {
      (taskFor(taskId).totals as Record<string, number>).duplicatedInformationTokens += Math.max(0, tokens);
    },

    recordMemoryValue(taskId, netValue) {
      // Not clamped: memory that cost more than it saved is the result worth
      // seeing, and flooring it at zero would make cross-run knowledge
      // unfalsifiable.
      (taskFor(taskId).totals as Record<string, number>).memoryNetValue += netValue;
    },

    recordSpend(taskId, bucket, tokens) {
      const t = taskFor(taskId).totals as Record<string, number>;
      const key = `${bucket}Tokens`;
      t[key] += Math.max(0, tokens);
    },

    decisions(taskId) {
      return [...(open.get(taskId)?.decisions.values() ?? [])];
    },

    finishTask(taskId, outcome, qualityScore = null) {
      const task = open.get(taskId) ?? openTask(now());
      open.delete(taskId);

      const record = buildEfficiencyRecord({
        ...task.totals,
        ...task.attribution,
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

/** Every task record this database holds, newest last.
 *
 *  The ledger itself only lives as long as the daemon; these rows are what a
 *  before/after comparison actually reads. Malformed rows are skipped rather
 *  than thrown on — a comparison that dies on one bad row is a comparison
 *  nobody runs twice. */
export function loadEfficiencyRecords(db: Db): EfficiencyRecord[] {
  return listMemory(db, 'efficiency_record')
    .map((row) => row.value as EfficiencyRecord | null)
    .filter((record): record is EfficiencyRecord =>
      typeof record?.taskId === 'string' && typeof record.totalTokens === 'number');
}
