/** A decision becomes real only here.
 *
 *  `chooseEconomicAction` is pure: it reads a state and names an action. That
 *  is what makes it replayable, and it is also why it cannot be what spends
 *  money — two decisions made against the same state would both look
 *  affordable. Commitment closes that gap in two moves, both checked at the
 *  same instant:
 *
 *   - **version** — the decision must have been made against the state as it
 *     is *now*. A decision against v17 arriving at v18 is stale, is refused,
 *     and is recomputed. It is never executed.
 *   - **reservation** — the conservative resource envelope the action may
 *     spend is held back from what later decisions see as available, and
 *     released (or replaced by actual spend) when the action settles.
 *
 *  Committing, starting, settling and cancelling are events on the one
 *  `EconomicState` reducer (`ACTION_*` in state.ts); there is no second state
 *  machine. `CommitmentBook` is the process-level holder for callers whose
 *  state is rebuilt from a database at every boundary: it carries what the
 *  rebuilt state cannot know — who has reserved what, and how many commitments
 *  have moved the version since the database was read. */
import { randomUUID } from 'node:crypto';
import type { ActionDecision } from './actions.js';
import { applyEconomicEvent, type EconomicState } from './state.js';
import { availableTokens, type ActionCommitment } from './transition.js';
import { signalEstimate } from './utility.js';

export type CommitRejection = 'stale_decision' | 'insufficient_resources' | 'blocked';

export type CommitResult =
  | { ok: true; commitment: ActionCommitment; state: EconomicState }
  | { ok: false; reason: CommitRejection; state: EconomicState };

/** The envelope reserved for an action: its immediate cost, loaded by the same
 *  ratio its conservative total carries over its expected total. An action the
 *  market was unsure about holds back more. */
export function reservationFor(decision: ActionDecision, state: EconomicState): ActionCommitment['reservedResources'] {
  const estimate = decision.estimate ?? signalEstimate(decision.action, state);
  const expected = estimate.immediateCost.usd + estimate.expectedRemainingCost.usd;
  const load = expected > 0 ? Math.max(1, estimate.bounds.costUpperBoundUsd / expected) : 1;
  return {
    tokens: Math.ceil(estimate.immediateCost.tokens * load),
    usd: estimate.immediateCost.usd * load,
    latencyMs: estimate.immediateCost.latencyMs,
  };
}

function affordableUsd(state: EconomicState): number {
  const r = state.resources;
  if (!r.budgetUsd || r.budgetUsd <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, r.budgetUsd - (r.spentUsd ?? 0) - (r.reservedUsd ?? 0));
}

/** Atomically: check the version, check the envelope fits, reserve it. Pure —
 *  returns the next state rather than touching this one. */
export function commitAction(
  state: EconomicState,
  decision: ActionDecision,
  options: { commitmentId?: string; now?: () => Date } = {},
): CommitResult {
  if (decision.stateVersion !== state.version) return { ok: false, reason: 'stale_decision', state };
  if (decision.blocked) return { ok: false, reason: 'blocked', state };

  const reserved = reservationFor(decision, state);
  // Only a positive reservation can fail to fit: the null action reserves
  // nothing and must stay committable on a run that has spent everything.
  if (reserved.tokens > 0 && reserved.tokens > availableTokens(state)) {
    return { ok: false, reason: 'insufficient_resources', state };
  }
  if (reserved.usd > 0 && reserved.usd > affordableUsd(state)) {
    return { ok: false, reason: 'insufficient_resources', state };
  }

  const commitment: ActionCommitment = {
    commitmentId: options.commitmentId ?? `cmt-${randomUUID()}`,
    decisionId: decision.decisionId,
    stateVersion: decision.stateVersion,
    action: decision.action,
    estimate: decision.estimate ?? signalEstimate(decision.action, state),
    reservedResources: reserved,
    committedAt: (options.now?.() ?? new Date()).toISOString(),
  };
  const next = applyEconomicEvent(state, {
    kind: 'ACTION_COMMITTED', commitmentId: commitment.commitmentId,
    reservedTokens: reserved.tokens, reservedUsd: reserved.usd,
  });
  return { ok: true, commitment, state: next };
}

export interface ActualUsage {
  tokens: number;
  usd: number;
  latencyMs: number;
  succeeded: boolean;
}

/** Replaces the reservation with what was actually spent. */
export function settleCommitment(state: EconomicState, commitment: ActionCommitment, actual: ActualUsage): EconomicState {
  return applyEconomicEvent(state, {
    kind: 'ACTION_COMPLETED', commitmentId: commitment.commitmentId,
    reservedTokens: commitment.reservedResources.tokens, reservedUsd: commitment.reservedResources.usd,
    actualTokens: actual.tokens, actualUsd: actual.usd, succeeded: actual.succeeded,
  });
}

export function cancelCommitment(state: EconomicState, commitment: ActionCommitment): EconomicState {
  return applyEconomicEvent(state, {
    kind: 'ACTION_CANCELLED', commitmentId: commitment.commitmentId,
    reservedTokens: commitment.reservedResources.tokens, reservedUsd: commitment.reservedResources.usd,
  });
}

/** Predicted against actual for one settled commitment. Actual minus
 *  predicted, always in that order: positive cost error means it cost more
 *  than promised. */
export interface PredictionError {
  costUsd: number;
  latencyMs: number;
  success: number;
}

export function predictionError(commitment: ActionCommitment, actual: ActualUsage): PredictionError {
  const e = commitment.estimate;
  const predictedSuccess = e.outcomes.filter((o) => o.succeeded).reduce((sum, o) => sum + o.probability, 0);
  return {
    costUsd: actual.usd - e.immediateCost.usd,
    latencyMs: actual.latencyMs - e.immediateCost.latencyMs,
    success: (actual.succeeded ? 1 : 0) - predictedSuccess,
  };
}

// ---------------------------------------------------------------------------
// The process-level book, for states rebuilt from storage at each boundary.
// ---------------------------------------------------------------------------

interface Scope {
  /** Bumped by every commit, settle and cancel. Added to the version the
   *  caller observed, so a decision made before another commitment landed is
   *  recognisably older. */
  epoch: number;
  open: Map<string, ActionCommitment>;
}

export class CommitmentBook {
  private readonly scopes = new Map<string, Scope>();

  private scope(key: string): Scope {
    let entry = this.scopes.get(key);
    if (!entry) { entry = { epoch: 0, open: new Map() }; this.scopes.set(key, entry); }
    return entry;
  }

  /** The state a decision should be made against: what storage says, plus what
   *  is reserved here and the epoch this book has moved it by. */
  view(key: string, observed: EconomicState): EconomicState {
    const scope = this.scope(key);
    let tokens = 0;
    let usd = 0;
    for (const c of scope.open.values()) { tokens += c.reservedResources.tokens; usd += c.reservedResources.usd; }
    return {
      ...observed,
      version: observed.version + scope.epoch,
      resources: {
        ...observed.resources,
        reservedTokens: (observed.resources.reservedTokens ?? 0) + tokens,
        reservedUsd: (observed.resources.reservedUsd ?? 0) + usd,
      },
    };
  }

  /** Commits against `current` — which must be `view(key, …)` of the state as
   *  it is *now*, not as it was when the decision was made. */
  commit(key: string, current: EconomicState, decision: ActionDecision): CommitResult {
    const result = commitAction(current, decision);
    if (result.ok) {
      const scope = this.scope(key);
      scope.open.set(result.commitment.commitmentId, result.commitment);
      scope.epoch += 1;
    }
    return result;
  }

  settle(key: string, commitmentId: string, actual: ActualUsage): { commitment: ActionCommitment; error: PredictionError } | null {
    const scope = this.scopes.get(key);
    const commitment = scope?.open.get(commitmentId);
    if (!scope || !commitment) return null;
    scope.open.delete(commitmentId);
    scope.epoch += 1;
    return { commitment, error: predictionError(commitment, actual) };
  }

  cancel(key: string, commitmentId: string): boolean {
    const scope = this.scopes.get(key);
    if (!scope?.open.delete(commitmentId)) return false;
    scope.epoch += 1;
    return true;
  }

  openCommitments(key: string): ActionCommitment[] {
    return [...(this.scopes.get(key)?.open.values() ?? [])];
  }

  forget(key: string): void {
    this.scopes.delete(key);
  }
}
