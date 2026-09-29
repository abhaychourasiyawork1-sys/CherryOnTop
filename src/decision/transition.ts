/** What we expect to happen if an action is taken — the contract every action
 *  provider speaks, and the only thing the Action Market reads to price one.
 *
 *  Three questions, kept apart on purpose:
 *
 *   - "What could we do next?"            → `ActionCandidate` (actions.ts)
 *   - "What do we expect will happen?"    → `ActionTransitionEstimate` (here)
 *   - "What should we finally choose?"    → `chooseEconomicAction` (engine.ts)
 *
 *  A provider that answers the third question itself is a second market. So a
 *  model router, the delegation economics, the evidence planner and the
 *  recovery engine all stop at the second: they may say what they expect, and
 *  the market alone decides.
 *
 *  Estimation is a funnel, cheapest first, and the first level that answers
 *  wins:
 *
 *      deterministic  → zero model, zero I/O (stop after validation, exact reuse)
 *      cache          → a prediction already made for this candidate in a
 *                       state that buckets the same
 *      empirical      → registered providers backed by hierarchical history
 *      signals        → the candidate's own effect signals (utility.ts)
 *
 *  Semantic refinement (System-1) is deliberately *not* a level here: it is an
 *  economic action the market decides whether to buy, see
 *  `semanticRefinementValue` in engine.ts.
 *
 *  Deterministic and total: no clock, no model. The cache is process memory,
 *  bounded, and keyed so a stale entry cannot answer a changed question. */
import { createHash } from 'node:crypto';
import type { ActionCandidate } from './actions.js';
import type { EconomicState, UncertaintyState } from './state.js';

export type EstimateProvenance = 'deterministic' | 'empirical' | 'semantic' | 'hybrid';

export interface TransitionOutcome {
  probability: number;
  /** The task is finished if this outcome happens (a validated answer, a reuse
   *  of one, a terminal stop). */
  completed: boolean;
  /** The action did what it said. */
  succeeded: boolean;
  nextStateDelta: {
    progress?: number;
    informationGain?: number;
    uncertainty?: Partial<UncertaintyState>;
    failurePressure?: number;
  };
}

export interface ActionTransitionEstimate {
  actionId: string;
  immediateCost: { tokens: number; usd: number; latencyMs: number };
  /** Sums to 1. Never empty. */
  outcomes: TransitionOutcome[];
  /** What finishing the task is expected to cost *after* this action, over its
   *  outcome distribution. For a terminal action it is zero. */
  expectedRemainingCost: { usd: number; tokens: number; latencyMs: number };
  bounds: {
    /** Conservative probability the result is correct if this is taken. The
     *  quality floor is checked against this, never against the mean. */
    successLowerBound: number;
    /** Conservative total cost (immediate + remaining). The market ranks on it. */
    costUpperBoundUsd: number;
  };
  confidence: number;
  provenance: EstimateProvenance;
  evidenceIds: string[];
}

/** We have atomically committed to this action against this exact state
 *  version, and reserved what it may spend. A commitment against a version
 *  that has since moved is never executed — see `commitment.ts`. */
export interface ActionCommitment {
  commitmentId: string;
  decisionId: string;
  stateVersion: number;
  action: ActionCandidate;
  estimate: ActionTransitionEstimate;
  reservedResources: { tokens: number; usd: number; latencyMs: number };
  committedAt: string;
}

// ---------------------------------------------------------------------------
// Identity: what makes two predictions the same prediction
// ---------------------------------------------------------------------------

/** The economically meaningful shape of a state, bucketed so that two states
 *  that differ trivially share evidence and a cache entry.
 *
 *  Quartiles, not deciles: the estimators downstream are not precise enough to
 *  tell 0.62 from 0.68, and a finer grid only splits evidence that should pool. */
export interface RoutingStateSignature {
  target: number;
  structural: number;
  behavioral: number;
  validation: number;
  progress: number;
  failurePressure: number;
  budget: number;
}

const BUCKETS = 4;

function bucket(value: number): number {
  const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
  return Math.min(BUCKETS - 1, Math.floor(v * BUCKETS));
}

export function routingStateSignature(state: EconomicState): RoutingStateSignature {
  const total = state.resources.totalTokenBudget;
  const budgetLeft = total > 0 ? availableTokens(state) / total : 1;
  return {
    target: bucket(state.uncertainty.target),
    structural: bucket(state.uncertainty.structural),
    behavioral: bucket(state.uncertainty.behavioral),
    validation: bucket(state.uncertainty.validation),
    progress: bucket(state.trajectory.progress),
    failurePressure: bucket(state.trajectory.failurePressure),
    budget: bucket(budgetLeft),
  };
}

/** One short string for a signature: a cache key part and a learning key. */
export function stateSignatureKey(signature: RoutingStateSignature): string {
  const s = signature;
  return `u${s.target}${s.structural}${s.behavioral}${s.validation}p${s.progress}f${s.failurePressure}b${s.budget}`;
}

/** Tokens this state may still commit: what is left, less what other
 *  commitments already hold. The one definition, so the market and the
 *  commitment check cannot disagree about what is affordable. */
export function availableTokens(state: EconomicState): number {
  return Math.max(0, state.resources.remainingTokens - (state.resources.reservedTokens ?? 0));
}

/** The identity of what a candidate *does*, not what it is called. For an
 *  execution candidate that is harness × model × effort plus the capability
 *  fingerprint of the harness it would run on — "Sonnet on Claude Code" and
 *  "Sonnet on Codex" are different actions with different evidence. The same
 *  fingerprint keys routing evidence, predictions, the result cache and
 *  calibration, so none of them can pool across different execution semantics. */
export function candidateFingerprint(candidate: ActionCandidate): string {
  const m = candidate.metadata;
  if (typeof m.fingerprint === 'string' && m.fingerprint) return m.fingerprint;
  return `${candidate.kind}:${candidate.capability}:${candidate.id}`;
}

// ---------------------------------------------------------------------------
// The funnel
// ---------------------------------------------------------------------------

export interface EstimationContext {
  /** What the task is, for evidence lookup and cache keys. Absent means the
   *  goal itself is hashed. */
  taskSignature?: string;
  /** Bumped whenever the evidence behind empirical estimates changes (a new
   *  observation lands). Part of the cache key, so a prediction made before
   *  the evidence moved cannot answer after it. */
  evidenceVersion?: string | number;
}

/** A level of the funnel. Returns null when it has nothing to say, which
 *  passes the question down to the next, cheaper-to-be-wrong level. Must not
 *  mutate the state — predictions never move state. */
export type TransitionEstimator = (
  candidate: ActionCandidate,
  state: EconomicState,
  context: EstimationContext,
) => ActionTransitionEstimate | null;

const empirical = new Map<string, TransitionEstimator>();

/** Registered by name and replaced on re-registration, the same idiom the deep
 *  path's candidate sources use: a provider is a property of the process, and
 *  two registrations must not produce two answers. Returns the unregister. */
export function registerEmpiricalEstimator(name: string, estimator: TransitionEstimator): () => void {
  empirical.set(name, estimator);
  return () => { if (empirical.get(name) === estimator) empirical.delete(name); };
}

export interface FunnelStats {
  cacheHits: number;
  cacheMisses: number;
  estimatorCalls: number;
}

const CACHE_LIMIT = 2_000;
const predictionCache = new Map<string, ActionTransitionEstimate>();

function taskSignatureOf(state: EconomicState, context: EstimationContext): string {
  return context.taskSignature ?? createHash('sha256').update(state.goal).digest('hex').slice(0, 16);
}

/** taskSignature + routingStateSignature + repositoryRevision +
 *  candidateFingerprint + capability fingerprint + evidence version. A change to any of them is a
 *  different question, so it cannot be answered by an old entry. */
export function predictionCacheKey(
  candidate: ActionCandidate,
  state: EconomicState,
  context: EstimationContext,
): string {
  const capability = typeof candidate.metadata.capabilityFingerprint === 'string'
    ? candidate.metadata.capabilityFingerprint : candidate.capability;
  return [
    taskSignatureOf(state, context),
    stateSignatureKey(routingStateSignature(state)),
    state.repositoryRevision ?? '-',
    candidateFingerprint(candidate),
    capability,
    // The candidate's own claims are inputs to every estimate: a changed
    // dispatch size or prior is a different question.
    [candidate.tokenCost, candidate.coordinationCost, candidate.failureRisk, candidate.qualityRisk,
      candidate.expectedTokenBenefit, candidate.expectedQualityBenefit, candidate.confidence].join(':'),
    String(context.evidenceVersion ?? 0),
  ].join('|');
}

/** Only empirical answers are cached. A deterministic one is cheaper to
 *  recompute than to look up, and a signal-derived one depends on exact
 *  numbers the bucketed key deliberately forgets. */
function cacheable(estimate: ActionTransitionEstimate): boolean {
  return estimate.provenance === 'empirical' || estimate.provenance === 'hybrid';
}

export function clearPredictionCache(): void {
  predictionCache.clear();
}

/** Runs the funnel for one candidate. `deterministic` and `signals` are
 *  supplied by the caller (the market owns both) so this module stays free of
 *  the cost model; only the middle levels live here. */
export function estimateTransition(
  candidate: ActionCandidate,
  state: EconomicState,
  context: EstimationContext,
  levels: {
    deterministic: (c: ActionCandidate, s: EconomicState) => ActionTransitionEstimate | null;
    signals: (c: ActionCandidate, s: EconomicState) => ActionTransitionEstimate;
  },
  stats: FunnelStats,
): ActionTransitionEstimate {
  const fixed = levels.deterministic(candidate, state);
  if (fixed) return fixed;

  const key = predictionCacheKey(candidate, state, context);
  const hit = predictionCache.get(key);
  if (hit) {
    stats.cacheHits += 1;
    return { ...hit, actionId: candidate.id };
  }
  stats.cacheMisses += 1;

  for (const estimator of empirical.values()) {
    stats.estimatorCalls += 1;
    let estimate: ActionTransitionEstimate | null = null;
    try {
      estimate = estimator(candidate, state, context);
    } catch (err) {
      // An estimator that throws has nothing to say; the next level does.
      console.error('A transition estimator failed; falling through to the next level:', err);
    }
    if (estimate && validEstimate(estimate)) {
      if (cacheable(estimate)) {
        if (predictionCache.size >= CACHE_LIMIT) {
          // Oldest first: Map iteration order is insertion order.
          predictionCache.delete(predictionCache.keys().next().value as string);
        }
        predictionCache.set(key, estimate);
      }
      return estimate;
    }
  }

  return levels.signals(candidate, state);
}

/** An estimate the arithmetic can trust: finite, non-negative costs and an
 *  outcome distribution that is one. Anything else is discarded rather than
 *  repaired — a repaired prediction is a prediction nobody made. */
export function validEstimate(estimate: ActionTransitionEstimate): boolean {
  const finiteNonNegative = (v: number) => Number.isFinite(v) && v >= 0;
  const total = estimate.outcomes.reduce((sum, o) => sum + o.probability, 0);
  return estimate.outcomes.length > 0
    && estimate.outcomes.every((o) => finiteNonNegative(o.probability))
    && Math.abs(total - 1) < 1e-6
    && finiteNonNegative(estimate.immediateCost.usd)
    && finiteNonNegative(estimate.immediateCost.tokens)
    && finiteNonNegative(estimate.expectedRemainingCost.usd)
    && finiteNonNegative(estimate.bounds.costUpperBoundUsd)
    && Number.isFinite(estimate.bounds.successLowerBound);
}
