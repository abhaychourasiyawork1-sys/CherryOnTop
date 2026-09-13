/** What one task cost, in the two currencies this work is measured in: tokens
 *  and wall-clock.
 *
 *  Every number here is read off something that already happens — the runtime's
 *  own `result` event, the ledger's phase timers — rather than estimated. The
 *  derived fields exist so that "where did the spend go?" is answerable without
 *  re-deriving ratios at every call site that asks. */

export type EfficiencyOutcome = 'success' | 'failure' | 'partial' | 'budget_exhausted';

export interface EfficiencyInput {
  /** The node this record is about. */
  taskId: string;
  outcome: EfficiencyOutcome;
  /** Billed input and output across every dispatch this task made. */
  inputTokens: number;
  outputTokens: number;
  /** The portion of `inputTokens` served from the provider's cache. A *slice*
   *  of input, never an addition to it. */
  cachedTokens: number;
  /** The portion of input+output spent deciding how to work rather than
   *  working: the plan and synthesize dispatches. Also a slice. */
  coordinationTokens: number;
  /** The portion spent re-running something that had already run — a model
   *  fallback retry. Also a slice. */
  recoveryTokens: number;
  planningCalls: number;
  executionCalls: number;
  synthesisCalls: number;
  /** Dispatches the efficiency work stopped from happening at all: a plan cache
   *  hit, a synthesis that a single complete child made unnecessary. These are
   *  the whole point of the exercise, so they are counted explicitly rather
   *  than inferred from an absence. */
  avoidedPlanningCalls: number;
  avoidedSynthesisCalls: number;
  /** Execute dispatches served from a previous identical run. The expensive
   *  one: an execute dispatch is the sandbox that does the actual work, and
   *  skipping one skips its whole turn loop rather than a single call. */
  avoidedExecutionCalls: number;
  /** What those avoided dispatches cost the last time they were paid for. A
   *  counterfactual, never added to `totalTokens` — a cache hit that showed up
   *  as spend would be a strange kind of saving. */
  tokensAvoided: number;
  retries: number;
  /** Time spent waiting for a sandbox slot rather than doing anything. */
  queueMs: number;
  /** Time inside dispatches spent getting ready to work rather than working:
   *  cluster scheduling, image pull, container start, agent boot. Summed across
   *  dispatches, like `dispatchMs`, and a *slice* of it. Telemetry only —
   *  whether warm pools or snapshots are worth their complexity is a question
   *  about this number, and nothing measured it before. */
  startupMs: number;
  /** Time inside dispatches, summed. Exceeds `endToEndMs` when work overlapped,
   *  which is exactly what makes it worth recording separately. */
  dispatchMs: number;
  endToEndMs: number;
  costUsd: number;
  /** Null when nothing scored this run. Never invented. */
  qualityScore: number | null;

  // ---- optimization attribution -------------------------------------------
  // What the optimizer did, and what it cost to do it. Without these a
  // before/after comparison can say spend moved and cannot say what moved it —
  // which is the difference between a measurement and an anecdote.

  /** Turns across every dispatch. The term whose cost grows superlinearly. */
  turns: number;
  /** Which planner and which policy generation produced this task's dispatches.
   *  Two generations in one database must be distinguishable rather than
   *  averaged into an uninterpretable middle. */
  contextPolicyVersion: string | null;
  executionPolicyVersion: string | null;
  /** Files with any evidence tying them to the goal, and how many were sent. */
  contextCandidates: number;
  contextSelected: number;
  /** What the context handed over was estimated to cost. */
  contextEstimatedTokens: number;
  /** [0,1], from the run's own tool stream. */
  explorationSignal: number;
  progressSignal: number;
  /** What choosing all of the above cost. Zero today and recorded anyway: the
   *  claim 'optimization is cheap' has to be a measurement, not an assumption,
   *  and a field nobody fills is a field nobody can falsify. */
  optimizationOverheadUsd: number;
  /** Why the task stopped, when something stopped it deliberately. Null when it
   *  simply finished. */
  stopReason: string | null;
}

export interface EfficiencyRecord extends EfficiencyInput {
  totalTokens: number;
  modelCalls: number;
  cacheHitRatio: number;
  coordinationTokenShare: number;
  recoveryTokenShare: number;
  synthesisAvoidanceRatio: number;
  /** Dispatches avoided over dispatches considered. The headline number for
   *  "did this system get cheaper as it accumulated reusable work?". */
  workAvoidedRatio: number;
  /** Startup over time inside dispatches. The gate for Part X of the plan: if
   *  this is small, warm pools and snapshots are machinery bought to save
   *  seconds on a path that costs minutes. */
  executionOverheadRatio: number;
  tokensPerModelCall: number;
  /** The acceptance metrics, all per *success*. A change that halves a total by
   *  failing twice as often raises every one of them, which is the point of
   *  dividing by successes rather than by tasks. Null unless this task
   *  succeeded — a failure has no cost-per-success to contribute. */
  costPerSuccessfulTask: number | null;
  turnsPerSuccessfulTask: number | null;
  cacheReadPerSuccessfulTask: number | null;
  /** Share of the trajectory spent looking. The mechanism the architecture
   *  claims to move; if it does not move, nothing else here is attributable. */
  explorationRatio: number;
  /** What the optimization saved over what it cost. Positive is a win, and a
   *  zero overhead with a positive saving reads as infinite — so it is capped
   *  at the saving itself, which is the honest floor on a ratio nobody can
   *  divide. */
  optimizationRoi: number;
  /** Null unless the task succeeded. The headline metric is cost *per success*:
   *  a change that halves tokens by failing twice as often is not an
   *  improvement, and averaging failures in would hide that. */
  tokensPerSuccessfulTask: number | null;
}

/** Every counter at zero. Spread over a fixture to describe a run that did
 *  nothing, without listing twenty fields to do it. */
export const EMPTY_TOTALS = {
  inputTokens: 0, outputTokens: 0, cachedTokens: 0, coordinationTokens: 0,
  recoveryTokens: 0, planningCalls: 0, executionCalls: 0, synthesisCalls: 0,
  avoidedPlanningCalls: 0, avoidedSynthesisCalls: 0, avoidedExecutionCalls: 0,
  tokensAvoided: 0, retries: 0, turns: 0,
  queueMs: 0, startupMs: 0, dispatchMs: 0, endToEndMs: 0, costUsd: 0,
  contextCandidates: 0, contextSelected: 0, contextEstimatedTokens: 0,
  explorationSignal: 0, progressSignal: 0, optimizationOverheadUsd: 0,
} as const;

/** The attribution fields a task carries that are not counters: they are the
 *  last value seen rather than a sum. */
export const EMPTY_ATTRIBUTION = {
  contextPolicyVersion: null as string | null,
  executionPolicyVersion: null as string | null,
  stopReason: null as string | null,
};

function share(part: number, whole: number): number {
  return whole <= 0 ? 0 : part / whole;
}

export function buildEfficiencyRecord(input: EfficiencyInput): EfficiencyRecord {
  // Input + output, and nothing else. The source plan's formula summed
  // observation and coordination tokens on top, which in this runtime would
  // count the same tokens two and three times over: coordination and recovery
  // are slices of the same input/output the runtime already billed, not
  // separate pools.
  const totalTokens = input.inputTokens + input.outputTokens;
  const modelCalls = input.planningCalls + input.executionCalls + input.synthesisCalls;
  const avoidedCalls = input.avoidedPlanningCalls + input.avoidedSynthesisCalls + input.avoidedExecutionCalls;
  const succeeded = input.outcome === 'success';
  // What the avoided work would have cost, priced from this task's own measured
  // rate. Zero tokens billed means no rate to price with, and an unpriceable
  // saving is reported as zero rather than guessed at.
  const savedUsd = totalTokens <= 0 ? 0 : input.tokensAvoided * (input.costUsd / totalTokens);

  return {
    ...input,
    totalTokens,
    modelCalls,
    cacheHitRatio: share(input.cachedTokens, input.inputTokens),
    coordinationTokenShare: share(input.coordinationTokens, totalTokens),
    recoveryTokenShare: share(input.recoveryTokens, totalTokens),
    synthesisAvoidanceRatio: share(
      input.avoidedSynthesisCalls,
      input.avoidedSynthesisCalls + input.synthesisCalls,
    ),
    workAvoidedRatio: share(avoidedCalls, avoidedCalls + modelCalls),
    executionOverheadRatio: share(input.startupMs, input.dispatchMs),
    tokensPerModelCall: share(totalTokens, modelCalls),
    tokensPerSuccessfulTask: succeeded ? totalTokens : null,
    costPerSuccessfulTask: succeeded ? input.costUsd : null,
    turnsPerSuccessfulTask: succeeded ? input.turns : null,
    cacheReadPerSuccessfulTask: succeeded ? input.cachedTokens : null,
    explorationRatio: share(input.explorationSignal, 1),
    // Tokens avoided, priced at what this task's own tokens cost, against what
    // the optimization spent. No prior measurement to price against means no
    // claim: zero, not an invented rate.
    optimizationRoi: input.optimizationOverheadUsd <= 0
      ? savedUsd
      : (savedUsd - input.optimizationOverheadUsd) / input.optimizationOverheadUsd,
  };
}
