/** What history says about this task's strategies, read at dispatch time.
 *
 *  The read side of hierarchical learning, and deliberately nothing else. It
 *  fetches stored observations at each level this task belongs to, hands them
 *  to the weighting rules in `learning/hierarchical.ts`, and returns a prior.
 *  It does not write, does not decide, and does not hold weighting logic of its
 *  own — three separate ways this could quietly become a second brain.
 *
 *  Total by construction: a database that cannot be read returns no evidence,
 *  and no evidence means the deterministic policy stands. An optimizer whose
 *  failure mode is "the runtime keeps its existing behaviour" is one worth
 *  having; one that can fail a dispatch is not. */
import type { Db } from '../db/client.js';
import { getStrategyOutcomes, type StoredStrategyOutcome } from '../db/queries/memory.js';
import {
  estimateStrategyPrior, LEARNING_LEVELS,
  type HierarchicalPrior, type LearningLevel, type StrategyOutcomeObservation,
} from '../learning/hierarchical.js';
import type { ExecutionStrategy } from './strategy-gate.js';
import type { DispatchPreparation } from './dispatch-preparation.js';
import type { PolicyVersion } from '../efficiency/policy-version.js';

/** The values this task is keyed by, level by level. `undefined` means the task
 *  has no key at that level and the level contributes nothing — which is not
 *  the same as the level having said nothing. */
export function learningKeysFor(preparation: DispatchPreparation): Partial<Record<LearningLevel, string>> {
  return {
    GLOBAL: 'all',
    TASK_CLASS: preparation.taskClass,
    TASK_SHAPE: preparation.taskShape,
    ...(preparation.repository ? { REPOSITORY: preparation.repository } : {}),
    // The narrowest key: this shape, in this repository, at this revision. Two
    // runs share it only when they are genuinely the same situation.
    ...(preparation.repository && preparation.repositoryRevision
      ? { EXACT_PATTERN: `${preparation.repository}@${preparation.taskShape}` }
      : {}),
  };
}

/** Widens the stored row back into the learning shape. The cast is contained
 *  here on purpose: exactly one place converts a JSON row into an observation,
 *  so a schema change breaks one function rather than five. */
function asObservation(stored: StoredStrategyOutcome): StrategyOutcomeObservation {
  return stored as unknown as StrategyOutcomeObservation;
}

export interface StrategyMemoryInput {
  preparation: DispatchPreparation;
  strategy?: ExecutionStrategy;
  policyVersion?: PolicyVersion;
}

/** The prior for one strategy on this task, from everything stored about it. */
export function strategyPriorFor(db: Db, input: StrategyMemoryInput): HierarchicalPrior {
  const keys = learningKeysFor(input.preparation);
  const byLevel: Partial<Record<Lowercase<LearningLevel>, StrategyOutcomeObservation[]>> = {};

  for (const level of LEARNING_LEVELS) {
    const value = keys[level];
    if (!value) continue;
    byLevel[camel(level)] = getStrategyOutcomes(db, level, value).map(asObservation);
  }

  return estimateStrategyPrior({
    global: byLevel.global ?? [],
    taskClass: byLevel.task_class ?? [],
    taskShape: byLevel.task_shape ?? [],
    repository: byLevel.repository ?? [],
    exactPattern: byLevel.exact_pattern ?? [],
    ...(input.strategy ? { strategy: input.strategy } : {}),
    ...(input.policyVersion ? { policyVersion: input.policyVersion } : {}),
  });
}

/** Priors for every strategy, so the economic gate can compare them rather than
 *  being handed one and asked to trust it. */
export function strategyPriorsFor(
  db: Db,
  input: Omit<StrategyMemoryInput, 'strategy'>,
): Record<ExecutionStrategy, HierarchicalPrior> {
  const strategies: ExecutionStrategy[] = ['MANAGED', 'SERIAL_DELEGATED', 'PARALLEL_DELEGATED'];
  return Object.fromEntries(
    strategies.map((strategy) => [strategy, strategyPriorFor(db, { ...input, strategy })]),
  ) as Record<ExecutionStrategy, HierarchicalPrior>;
}

function camel(level: LearningLevel): Lowercase<LearningLevel> {
  return level.toLowerCase() as Lowercase<LearningLevel>;
}
