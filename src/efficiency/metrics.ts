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
  retries: number;
  /** Time spent waiting for a sandbox slot rather than doing anything. */
  queueMs: number;
  /** Time inside dispatches, summed. Exceeds `endToEndMs` when work overlapped,
   *  which is exactly what makes it worth recording separately. */
  dispatchMs: number;
  endToEndMs: number;
  costUsd: number;
  /** Null when nothing scored this run. Never invented. */
  qualityScore: number | null;
}

export interface EfficiencyRecord extends EfficiencyInput {
  totalTokens: number;
  modelCalls: number;
  cacheHitRatio: number;
  coordinationTokenShare: number;
  recoveryTokenShare: number;
  synthesisAvoidanceRatio: number;
  tokensPerModelCall: number;
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
  avoidedPlanningCalls: 0, avoidedSynthesisCalls: 0, retries: 0,
  queueMs: 0, dispatchMs: 0, endToEndMs: 0, costUsd: 0,
} as const;

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
    tokensPerModelCall: share(totalTokens, modelCalls),
    tokensPerSuccessfulTask: input.outcome === 'success' ? totalTokens : null,
  };
}
