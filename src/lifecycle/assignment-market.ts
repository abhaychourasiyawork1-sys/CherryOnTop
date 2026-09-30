/** What to do about work the parent has just refused, decided by the Action Market.
 *
 *  The delegation loop asks one question after a failed review — keep the same
 *  child working, hand the work to a different one, or stop and ask — and a fixed
 *  rule (rework twice, then stop) answers it the same way whether the child was
 *  one fix away or is walking into the same wall for the third time. The market
 *  already prices exactly this: `evaluateRecovery` prices a retry with what it
 *  inherits and how many times it has already died the same way, and
 *  `chooseEconomicAction` ranks it. This translates the assignment's situation
 *  into that vocabulary and the market's answer back into a decision. It adds no
 *  optimiser of its own.
 *
 *   - **Rework** is a recovery that *keeps* what the child established: its
 *     evidence survives and the price falls with it.
 *   - **Reassign** is a recovery that *starts over*: a fresh owner has no
 *     evidence and no history of repeating itself, but pays for the whole
 *     remaining piece, and the handoff.
 *   - **Neither worth it** is the market's null action — carry on as we are — and
 *     for a refused assignment that means stop and ask (escalate).
 *
 *  What it cannot do is accept. The verdict on the work is the review's, and a
 *  decision that can only choose among ways of continuing cannot overrule it.
 *  The hard limits — the rework cap, the reassignment cap, the child's budget —
 *  stay in the loop and apply to whatever this says.
 *
 *  Where nothing has been measured yet (no tokens consumed) the market has no
 *  basis to overrule the default, and defers to it: doubt reduces intervention,
 *  and the default here is the same child, reworked.
 *
 *  Pure given its inputs: the state is supplied, and the same state and history
 *  give the same decision. */
import { chooseEconomicAction } from '../decision/engine.js';
import { actionCandidate, type ActionCandidate } from '../decision/actions.js';
import type { EconomicState } from '../decision/state.js';
import { evaluateRecovery, recoveryCandidate, strategyRetryAllowed, type RecoveryTombstone } from '../recovery/engine.js';
import type { ParentFeedback } from '../schemas/delegation.js';
import type { RecoveryContext, RecoveryDecision } from './delegate-child.js';
import { MAX_REWORK_CONTEXT_CHARS } from './delegation-reports.js';

export const REWORK_ID = 'assignment:rework';
export const REASSIGN_ID = 'assignment:reassign';

/** How a refusal died, in a stable form: which checks failed, not what was said
 *  about them. Two refusals for the same checks are the same wall. */
export function failureSignatureOf(feedback: Pick<ParentFeedback, 'failedChecks'>): string {
  const checks = [...new Set(feedback.failedChecks.map((failed) => failed.check.trim().toLowerCase()))].sort();
  return `acceptance:${checks.join('|') || 'unspecified'}`;
}

export interface AssignmentMarketInput {
  context: RecoveryContext;
  /** The child's own economic state: what it has spent, how far it got, what it
   *  established. Built from its records by the caller. */
  state: EconomicState;
  /** Whether a different owner is permitted and can be funded. When false the
   *  market is not offered the option. */
  canReassign: boolean;
  decisionId?: string;
}

export interface AssignmentMarketReceipt {
  decisionId: string;
  chosen: string;
  action: RecoveryDecision['action'];
  reasonCodes: string[];
  failureSignature: string;
  /** Earlier refusals of the same checks. What makes a repeat cost more. */
  sameFailureBefore: number;
  offered: string[];
}

export interface AssignmentMarketResult {
  decision: RecoveryDecision;
  receipt: AssignmentMarketReceipt;
}

/** Earlier refusals as the recovery model's own record of a strategy that did
 *  not work — the same shape node-level recovery keeps. */
function tombstonesFrom(context: RecoveryContext): RecoveryTombstone[] {
  return context.assignment.feedbackHistory.map((earlier, index) => ({
    id: `${context.assignment.id}:${index}`,
    hypothesisIds: [], retainedEvidenceIds: [], invalidatedEvidenceIds: [],
    failureSignature: failureSignatureOf(earlier),
    tokensSpent: 0,
  }));
}

export function decideAssignmentRecovery(input: AssignmentMarketInput): AssignmentMarketResult {
  const { context, state } = input;
  const failureSignature = failureSignatureOf(context.feedback);
  const tombstones = tombstonesFrom(context);
  const sameFailureBefore = tombstones.filter((t) => t.failureSignature === failureSignature).length;
  const decisionId = input.decisionId ?? `assignment-${context.assignment.id}-${context.assignment.revision}`;
  const receiptFor = (chosen: string, action: RecoveryDecision['action'], reasonCodes: string[], offered: string[]): AssignmentMarketReceipt =>
    ({ decisionId, chosen, action, reasonCodes, failureSignature, sameFailureBefore, offered });

  // Nothing measured: no basis to overrule the default.
  if (state.resources.consumedTokens <= 0) {
    return {
      decision: { action: 'rework' },
      receipt: receiptFor(REWORK_ID, 'rework', ['market:no_measurement', 'defers_to_default'], []),
    };
  }

  const candidates: ActionCandidate[] = [];

  // Rework: keeps what the child established, and pays a growing price for
  // each time it has already died this way. And it is refused outright when it
  // would be the same idea again: the same checks failing a second time with
  // nothing gained between (`strategyRetryAllowed`, the recovery layer's own
  // rule, measured on three full dispatches into one identical refusal). "Not
  // the same idea again" — never "not again": a different owner is exactly the
  // different idea.
  const sameIdeaAgain = !strategyRetryAllowed({
    currentStrategy: `rework:${context.assignment.childId}`,
    previousStrategies: tombstones.map(() => `rework:${context.assignment.childId}`),
    failureSignature,
    previousFailureSignatures: tombstones.map((t) => t.failureSignature),
    progress: state.trajectory.progress,
  });
  const reworkEvaluation = evaluateRecovery({ state, failureSignature, tombstones });
  if (reworkEvaluation.justified && !sameIdeaAgain) {
    candidates.push({
      ...recoveryCandidate(reworkEvaluation, state),
      id: REWORK_ID,
      capability: 'delegation.rework',
      metadata: { action: 'rework', reasonCodes: reworkEvaluation.reasonCodes },
    });
  }

  // Reassign: a fresh owner, with none of the evidence and none of the history.
  //
  // Priced for what it is, not as a retry. A retry is valued by the spend it
  // stops being wasted (the recovery model's `consumedTokens`); a fresh owner
  // recovers none of that — it is valued by finishing the piece, which the
  // market expresses as the progress it is expected to close. And what it costs
  // is not "everything that is left" either: a from-scratch attempt costs about
  // what the last one did (what the child consumed is the only measurement of
  // the piece there is), plus the handoff that tells the new owner what the old
  // one established. Priced either of the other ways it could never be chosen.
  if (input.canReassign) {
    const handoffTokens = Math.round(MAX_REWORK_CONTEXT_CHARS / 4);
    const cost = state.resources.consumedTokens + handoffTokens;
    if (cost <= state.resources.remainingTokens) {
      const fresh: EconomicState = {
        ...state, evidence: [], trajectory: { ...state.trajectory, progress: 0 },
      };
      const freshEvaluation = evaluateRecovery({ state: fresh, failureSignature: 'fresh-owner', tombstones: [] });
      const probability = freshEvaluation.expectedSuccessProbability;
      candidates.push(actionCandidate({
        id: REASSIGN_ID, kind: 'recover', capability: 'delegation.reassign',
        expectedProgress: probability,
        tokenCost: cost,
        // The handoff is coordination, not work.
        coordinationCost: handoffTokens,
        failureRisk: 1 - probability,
        confidence: state.trajectory.orchestrationConfidence,
        metadata: { action: 'reassign', reasonCodes: freshEvaluation.reasonCodes },
      }));
    }
  }

  const offered = candidates.map((candidate) => candidate.id);
  const chosen = chooseEconomicAction({ state, candidates, decisionId, nowMs: () => 0 });
  const codes = chosen.reasonCodes;

  if (chosen.action.id === REWORK_ID) {
    return { decision: { action: 'rework' }, receipt: receiptFor(REWORK_ID, 'rework', codes, offered) };
  }
  if (chosen.action.id === REASSIGN_ID) {
    const decision: RecoveryDecision = {
      action: 'reassign',
      reason: sameFailureBefore > 0
        ? `the same checks have been refused ${sameFailureBefore + 1} times: a fresh owner is cheaper than another revision`
        : 'a fresh owner is cheaper than another revision',
      decidedBy: `market:${chosen.decisionId}`,
      evidenceRefs: [`decision:${chosen.decisionId}`],
    };
    return { decision, receipt: receiptFor(REASSIGN_ID, 'reassign', codes, offered) };
  }
  // The null action: nothing on the menu beat carrying on as we are, and for a
  // refused assignment that is asking someone.
  return {
    decision: {
      action: 'escalate',
      reason: `the market judged another attempt not worth its cost (${codes.slice(0, 4).join(', ') || 'no justified option'})`,
    },
    receipt: receiptFor(chosen.action.id, 'escalate', codes, offered),
  };
}
