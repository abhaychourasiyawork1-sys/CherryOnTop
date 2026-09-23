/** What history says about a strategy, at the right level of specificity.
 *
 *  The memory this replaces was keyed by runtime and a three-band complexity
 *  guess, which is too coarse to be actionable and too specific to be safe at
 *  the same time. A one-line typo fix and a cross-module bug hunt share a band
 *  and have nothing else in common; meanwhile "this exact task shape delegated
 *  well once" is a table with one row in it and no business outvoting anything.
 *
 *  So evidence is keyed at five levels, from broadest to narrowest, and a more
 *  specific level earns influence only as its evidence accumulates:
 *
 *      GLOBAL → TASK_CLASS → TASK_SHAPE → REPOSITORY → EXACT_PATTERN
 *
 *  The shrinkage is the whole design. With one exact-shape sample, the estimate
 *  barely moves off the broader evidence — because one sample is a coin toss
 *  wearing a specific label, and a policy that follows it is a policy that
 *  changes its mind every run. With thirty, it dominates, because by then it is
 *  actually saying something. The alternative is not "less learning"; it is
 *  learning that oscillates, which is worse than none.
 *
 *  Weighting and aggregation live here. Storage lives in
 *  `db/queries/memory.ts`, and promotion lives in `policy-experiments.ts` —
 *  this module proposes evidence and decides nothing. Deterministic and total:
 *  no clock, no database, no model. */
import type { ExecutionStrategy, StrategyPrior } from '../decision/strategy-gate.js';
import type { ValidationLevel } from '../validation/contract.js';
import { comparable, type PolicyVersion } from '../efficiency/policy-version.js';

export type LearningLevel = 'GLOBAL' | 'TASK_CLASS' | 'TASK_SHAPE' | 'REPOSITORY' | 'EXACT_PATTERN';

/** Broadest first. The order is the shrinkage order, and reversing it would
 *  make a single exact sample the starting point rather than the correction. */
export const LEARNING_LEVELS: readonly LearningLevel[] =
  ['GLOBAL', 'TASK_CLASS', 'TASK_SHAPE', 'REPOSITORY', 'EXACT_PATTERN'];

export interface LearningKey {
  level: LearningLevel;
  value: string;
}

/** Exactly the benchmark harness's classification. Anything that is not
 *  `VALID` is counted and then excluded rather than dropped silently: "twelve
 *  runs, nine of them valid" and "nine runs" are different statements and only
 *  the first is honest. */
export type ObservationValidity =
  | 'VALID' | 'INVALID_INFRA' | 'INVALID_ENV' | 'INVALID_TELEMETRY' | 'INVALID_SNAPSHOT' | 'ABORTED';

/** Clean success and success-after-recovery are different outcomes with
 *  different costs, and collapsing them into a boolean is how a strategy that
 *  only ever works on the second attempt looks as good as one that works. */
export type StrategyOutcomeKind = 'SUCCESS' | 'SUCCESS_WITH_RECOVERY' | 'FAILURE';

export interface StrategyOutcomeObservation {
  strategy: ExecutionStrategy;
  /** The keys this observation is evidence for, at every level it applies to. */
  task: LearningKey[];
  success: boolean;
  /** Candidate minus baseline quality, on [-1,1]. */
  qualityDelta: number;
  costUsd: number;
  latencyMs: number;
  recoveryCount: number;
  validationLevel: ValidationLevel;
  validity: ObservationValidity;
  policyVersion?: PolicyVersion;
}

export function outcomeKindOf(observation: Pick<StrategyOutcomeObservation, 'success' | 'recoveryCount'>): StrategyOutcomeKind {
  if (!observation.success) return 'FAILURE';
  return observation.recoveryCount > 0 ? 'SUCCESS_WITH_RECOVERY' : 'SUCCESS';
}

/** Turns a finished, *validated* run into learnable evidence.
 *
 *  Only verified outcomes get here. A run whose validation failed is evidence
 *  about the run, not about the strategy, and feeding it in as a strategy
 *  failure would blame the topology for the agent's mistake. */
export function observationFrom(input: {
  strategy: ExecutionStrategy;
  taskClass: string;
  taskShape: string;
  repository?: string;
  exactPattern?: string;
  validated: boolean;
  qualityDelta: number;
  costUsd: number;
  latencyMs: number;
  recoveryCount: number;
  validationLevel: ValidationLevel;
  validity?: ObservationValidity;
  policyVersion?: PolicyVersion;
}): StrategyOutcomeObservation {
  const task: LearningKey[] = [
    { level: 'GLOBAL', value: 'all' },
    { level: 'TASK_CLASS', value: input.taskClass },
    { level: 'TASK_SHAPE', value: input.taskShape },
  ];
  if (input.repository) task.push({ level: 'REPOSITORY', value: input.repository });
  if (input.exactPattern) task.push({ level: 'EXACT_PATTERN', value: input.exactPattern });

  return {
    strategy: input.strategy,
    task,
    success: input.validated,
    qualityDelta: input.qualityDelta,
    costUsd: input.costUsd,
    latencyMs: input.latencyMs,
    recoveryCount: Math.max(0, input.recoveryCount),
    validationLevel: input.validationLevel,
    validity: input.validity ?? 'VALID',
    ...(input.policyVersion ? { policyVersion: input.policyVersion } : {}),
  };
}

/** How many observations a level needs before it speaks with its own voice.
 *
 *  At `n = K` a level carries half the weight; at `n = 1` it carries a ninth.
 *  Tied to `MIN_VALID_OBSERVATIONS` in `policy-experiments.ts` deliberately:
 *  the number of runs it takes to *promote* a policy and the number it takes to
 *  *believe* a level are the same judgement, and two constants for one
 *  judgement drift. */
export const SHRINKAGE_K = 8;

export function levelWeight(observationCount: number): number {
  const n = Math.max(0, observationCount);
  return n / (n + SHRINKAGE_K);
}

export interface EstimateInput {
  global?: StrategyOutcomeObservation[];
  taskClass?: StrategyOutcomeObservation[];
  taskShape?: StrategyOutcomeObservation[];
  repository?: StrategyOutcomeObservation[];
  exactPattern?: StrategyOutcomeObservation[];
  /** The policy generation the estimate is *for*. Observations from an
   *  incomparable generation describe neither and are excluded. */
  policyVersion?: PolicyVersion;
  /** Which strategy this prior is about. Absent means "whatever the evidence
   *  is mostly about", which is the honest answer when nobody asked. */
  strategy?: ExecutionStrategy;
}

export interface EvidenceCensus {
  total: number;
  used: number;
  /** Excluded, by why. The number that turns "it did not work" into "we could
   *  not tell". */
  excluded: Record<string, number>;
}

export interface HierarchicalPrior extends StrategyPrior {
  sourceLevels: LearningKey[];
  census: EvidenceCensus;
  /** Clean successes, successes that needed recovery, failures. */
  outcomes: Record<StrategyOutcomeKind, number>;
}

/** The starting point when nothing is known. Deliberately unexciting: a prior
 *  that claims a strategy works 90% of the time before anything has been
 *  observed is a prior that will recommend it. */
const UNINFORMED = { success: 0.5, quality: 0, costUsd: 0, latencyMs: 0 };

function usable(
  observations: StrategyOutcomeObservation[],
  input: EstimateInput,
  census: EvidenceCensus,
): StrategyOutcomeObservation[] {
  return observations.filter((observation) => {
    census.total += 1;
    if (observation.validity !== 'VALID') {
      census.excluded[observation.validity] = (census.excluded[observation.validity] ?? 0) + 1;
      return false;
    }
    if (input.policyVersion && observation.policyVersion
        && !comparable(observation.policyVersion, input.policyVersion)) {
      census.excluded.INCOMPARABLE_POLICY = (census.excluded.INCOMPARABLE_POLICY ?? 0) + 1;
      return false;
    }
    if (input.strategy && observation.strategy !== input.strategy) {
      census.excluded.OTHER_STRATEGY = (census.excluded.OTHER_STRATEGY ?? 0) + 1;
      return false;
    }
    census.used += 1;
    return true;
  });
}

const mean = (values: number[], fallback: number): number =>
  values.length === 0 ? fallback : values.reduce((a, b) => a + b, 0) / values.length;

/** The prior, with each level pulled toward the broader one it sits inside.
 *
 *  Walks broadest to narrowest. Every step is a weighted move toward that
 *  level's own mean, and the weight is the level's evidence count against
 *  `SHRINKAGE_K` — so a level with nothing to say moves the estimate by
 *  nothing, and one with plenty moves it most of the way. */
export function estimateStrategyPrior(input: EstimateInput): HierarchicalPrior {
  const census: EvidenceCensus = { total: 0, used: 0, excluded: {} };
  const byLevel: Array<{ level: LearningLevel; observations: StrategyOutcomeObservation[] }> = [
    { level: 'GLOBAL', observations: usable(input.global ?? [], input, census) },
    { level: 'TASK_CLASS', observations: usable(input.taskClass ?? [], input, census) },
    { level: 'TASK_SHAPE', observations: usable(input.taskShape ?? [], input, census) },
    { level: 'REPOSITORY', observations: usable(input.repository ?? [], input, census) },
    { level: 'EXACT_PATTERN', observations: usable(input.exactPattern ?? [], input, census) },
  ];

  let estimate = { ...UNINFORMED };
  let effective = 0;
  const sourceLevels: LearningKey[] = [];
  const outcomes: Record<StrategyOutcomeKind, number> = {
    SUCCESS: 0, SUCCESS_WITH_RECOVERY: 0, FAILURE: 0,
  };

  for (const { level, observations } of byLevel) {
    if (observations.length === 0) continue;
    for (const observation of observations) outcomes[outcomeKindOf(observation)] += 1;

    const weight = levelWeight(observations.length);
    const levelMean = {
      success: mean(observations.map((o) => (o.success ? 1 : 0)), estimate.success),
      quality: mean(observations.map((o) => o.qualityDelta), estimate.quality),
      costUsd: mean(observations.map((o) => o.costUsd), estimate.costUsd),
      latencyMs: mean(observations.map((o) => o.latencyMs), estimate.latencyMs),
    };

    estimate = {
      success: estimate.success * (1 - weight) + levelMean.success * weight,
      quality: estimate.quality * (1 - weight) + levelMean.quality * weight,
      costUsd: estimate.costUsd * (1 - weight) + levelMean.costUsd * weight,
      latencyMs: estimate.latencyMs * (1 - weight) + levelMean.latencyMs * weight,
    };
    // What the estimate is actually resting on, in weight rather than in rows:
    // five exact samples is not five observations' worth of confidence.
    effective += observations.length * weight;
    sourceLevels.push({ level, value: observations[0].task.find((key) => key.level === level)?.value ?? level });
  }

  return {
    strategy: input.strategy ?? byLevel.flatMap((entry) => entry.observations)[0]?.strategy ?? 'MANAGED',
    expectedSuccess: estimate.success,
    expectedQuality: estimate.quality,
    expectedCostUsd: estimate.costUsd,
    expectedLatencyMs: estimate.latencyMs,
    effectiveObservations: Number(effective.toFixed(4)),
    sourceLevels,
    census,
    outcomes,
  };
}
