/** When to stop paying for a task that is not getting anywhere.
 *
 *  The primary invariant is money. Turns are a supporting signal and
 *  trajectory quality is a supporting signal, and both exist to catch the case
 *  money alone catches too late: a run that will certainly fail, and will spend
 *  its whole allowance discovering that.
 *
 *  Two rules shape every threshold below, both learned from a measured run:
 *
 *   - **Hard spend outranks everything.** A task with turns remaining and no
 *     money left is over. The reverse — turns exhausted, money remaining — is
 *     also over, because the turn cap is the only protection left when spend
 *     telemetry is missing, and a runtime that reports no cost must not thereby
 *     become unbounded.
 *
 *   - **A high turn count is not, by itself, a reason to stop.** The most
 *     expensive run this repository has measured took 42 turns and was
 *     genuinely working; the one before it took 19 and was not. Stopping on
 *     turns alone would have killed the wrong one. So the only non-hard stop
 *     requires three things at once — real money spent, past the point the task
 *     was judged to need, and observable evidence of no progress — and it
 *     requires spend telemetry to exist, because a guard that fires on missing
 *     data fires on every runtime that does not report cost.
 *
 *  Deterministic and total: no model, no clock, no I/O. */

export type GuardState = 'GREEN' | 'AMBER' | 'RED' | 'STOP';

export interface SpendGuardState {
  state: GuardState;
  spentUsd: number;
  spendCapUsd: number;
  /** Why this state, in a sentence a person reading a transcript can act on.
   *  Null only when the answer is GREEN — "everything is fine" needs no
   *  explanation. */
  reason: string | null;
}

export interface SpendGuardInput {
  spentUsd: number;
  /** 0 means "nobody costed this task", never "out of money" — the same
   *  convention `model-router.ts` and the contract's `budget_usd` already use. */
  spendCapUsd: number;
  turns: number;
  softTurnTarget: number;
  hardTurnCap: number;
  /** [0,1]. How much of the trajectory was looking rather than doing. */
  explorationSignal: number;
  /** [0,1]. How much of it produced something: an edit, a passing command. */
  progressSignal: number;
}

/** Fractions of the spend cap at which the state escalates. RED is a warning
 *  with room to land in; AMBER is "this is costing more than it looked like". */
const RED_SHARE = 0.85;
const AMBER_SHARE = 0.6;

/** The non-hard stop needs all of these, together. Deliberately hard to trip. */
const STALL_SPEND_SHARE = 0.5;
const STALL_PROGRESS = 0.1;
const STALL_EXPLORATION = 0.8;

const finite = (value: number, fallback = 0): number =>
  (Number.isFinite(value) ? value : fallback);

const clamp01 = (value: number): number => Math.min(1, Math.max(0, finite(value, 0.5)));

export function evaluateSpendGuard(input: SpendGuardInput): SpendGuardState {
  const spentUsd = Math.max(0, finite(input.spentUsd));
  const spendCapUsd = Math.max(0, finite(input.spendCapUsd));
  const turns = Math.max(0, finite(input.turns));
  const hardTurnCap = Math.max(0, finite(input.hardTurnCap));
  const softTurnTarget = Math.max(0, finite(input.softTurnTarget));
  const exploration = clamp01(input.explorationSignal);
  const progress = clamp01(input.progressSignal);

  const capped = spendCapUsd > 0;
  const share = capped ? spentUsd / spendCapUsd : 0;
  const stop = (reason: string): SpendGuardState => ({ state: 'STOP', spentUsd, spendCapUsd, reason });

  // Money first, always. Turns remaining do not buy anything when there is
  // nothing left to buy it with.
  if (capped && spentUsd >= spendCapUsd) {
    return stop(`Spend cap reached — $${spentUsd.toFixed(2)} of $${spendCapUsd.toFixed(2)}.`);
  }

  // And turns second, even with money left: when a runtime reports no cost at
  // all this is the only bound there is, and an unbounded turn loop is the one
  // term whose price grows superlinearly.
  if (hardTurnCap > 0 && turns >= hardTurnCap) {
    return stop(`Turn cap reached — ${turns} of ${hardTurnCap} turns.`);
  }

  // The stall. Three conditions at once, and only where spend is actually being
  // measured: a guard that fires on missing telemetry fires on every runtime
  // that does not report cost.
  if (
    capped
    && share >= STALL_SPEND_SHARE
    && softTurnTarget > 0 && turns >= softTurnTarget
    && progress <= STALL_PROGRESS
    && exploration >= STALL_EXPLORATION
  ) {
    return stop(
      `No progress after ${turns} turns and $${spentUsd.toFixed(2)} — the trajectory is searching, not working.`,
    );
  }

  if (capped && share >= RED_SHARE) {
    return { state: 'RED', spentUsd, spendCapUsd, reason: `${Math.round(share * 100)}% of the spend cap is gone.` };
  }
  if (hardTurnCap > 0 && turns >= hardTurnCap * RED_SHARE) {
    return { state: 'RED', spentUsd, spendCapUsd, reason: `${turns} of ${hardTurnCap} turns used.` };
  }
  if (capped && share >= AMBER_SHARE) {
    return { state: 'AMBER', spentUsd, spendCapUsd, reason: `${Math.round(share * 100)}% of the spend cap is gone.` };
  }
  if (softTurnTarget > 0 && turns > softTurnTarget) {
    return {
      state: 'AMBER', spentUsd, spendCapUsd,
      reason: `Past the ${softTurnTarget}-turn target this task was judged to need.`,
    };
  }

  return { state: 'GREEN', spentUsd, spendCapUsd, reason: null };
}
