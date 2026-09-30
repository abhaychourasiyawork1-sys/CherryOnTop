import { describe, it, expect } from 'vitest';
import { decideAssignmentRecovery, failureSignatureOf, REWORK_ID, REASSIGN_ID } from './assignment-market.js';
import { initialEconomicState, normalizeEconomicState, type EconomicState } from '../decision/state.js';
import type { RecoveryContext } from './delegate-child.js';
import type { DelegationRecord, ParentFeedback } from '../schemas/delegation.js';

const feedbackFor = (...checks: string[]): ParentFeedback => ({
  assignmentId: 'a1', revision: 5,
  failedChecks: checks.map((check) => ({ check, observed: 'no run', expected: 'green', evidenceRefs: [] })),
  requiredChanges: [], guidance: [], nextChecks: checks,
});

function context(current: ParentFeedback, earlier: ParentFeedback[] = []): RecoveryContext {
  const assignment = {
    id: 'a1', parentId: 'p', childId: 'c1', goal: 'g', definitionOfDone: [], acceptanceChecks: [], dependencies: [],
    status: 'FEEDBACK_REQUIRED', revision: 7, attempt: 1 + earlier.length, budgetUsd: 1,
    feedback: current, feedbackHistory: earlier, createdAt: 't', updatedAt: 't',
  } as DelegationRecord;
  return { assignment, feedback: current, reworks: earlier.length, run: { succeeded: true } };
}

/** A child's state after it has run: tokens spent, some distance covered, some evidence. */
function state(o: { consumed?: number; total?: number; progress?: number; evidence?: number; budgetUsd?: number; spentUsd?: number } = {}): EconomicState {
  const base = initialEconomicState({ goal: 'g', totalTokenBudget: o.total ?? 500_000 });
  return normalizeEconomicState({
    ...base,
    evidence: Array.from({ length: o.evidence ?? 0 }, (_, i) => ({
      id: `e${i}`, kind: 'fact' as const, source: 's', confidence: 0.9, tokenCost: 4_000,
    })),
    resources: {
      ...base.resources, consumedTokens: o.consumed ?? 150_000,
      ...(o.budgetUsd ? { budgetUsd: o.budgetUsd, spentUsd: o.spentUsd ?? 0, usdPerToken: 0.000006 } : {}),
    },
    trajectory: { ...base.trajectory, progress: o.progress ?? 0.5, orchestrationConfidence: 0.8 },
  });
}

const NPM = 'npm test passes';

describe('failureSignatureOf', () => {
  it('names the wall by which checks failed, not by what was said about them', () => {
    expect(failureSignatureOf(feedbackFor(NPM))).toBe(failureSignatureOf({
      failedChecks: [{ check: '  NPM TEST passes ', observed: 'something else entirely', expected: 'x', evidenceRefs: [] }],
    }));
    expect(failureSignatureOf(feedbackFor(NPM))).not.toBe(failureSignatureOf(feedbackFor('tsc is clean')));
  });

  it('does not depend on the order checks were listed in', () => {
    expect(failureSignatureOf(feedbackFor('a', 'b'))).toBe(failureSignatureOf(feedbackFor('b', 'a')));
  });
});

describe('assignment recovery, decided by the market', () => {
  it('sends a child that made progress and holds evidence back for another revision', () => {
    const { decision, receipt } = decideAssignmentRecovery({
      context: context(feedbackFor(NPM)), state: state({ progress: 0.5, evidence: 4 }), canReassign: true, decisionId: 'd1',
    });
    expect(decision).toEqual({ action: 'rework' });
    expect(receipt).toMatchObject({ chosen: REWORK_ID, action: 'rework', sameFailureBefore: 0, decisionId: 'd1' });
    expect(receipt.offered).toContain(REWORK_ID);
  });

  it('refuses the same idea a third time, and hands a small piece to a fresh owner', () => {
    // Three refusals of one wall with nothing gained between them: reworking the
    // same way again is refused outright (`strategyRetryAllowed`), and the piece
    // is small enough that starting over is cheap.
    const { decision, receipt } = decideAssignmentRecovery({
      context: context(feedbackFor(NPM), [feedbackFor(NPM), feedbackFor(NPM)]),
      state: state({ consumed: 60_000, progress: 0.02, evidence: 2 }), canReassign: true, decisionId: 'd2',
    });
    expect(decision.action).toBe('reassign');
    if (decision.action !== 'reassign') throw new Error('unreachable');
    // An explicit decision with a reason and a decider, as reassignment requires.
    expect(decision.reason).toMatch(/refused 3 times/);
    expect(decision.decidedBy).toBe('market:d2');
    expect(decision.evidenceRefs).toEqual(['decision:d2']);
    expect(receipt).toMatchObject({ chosen: REASSIGN_ID, action: 'reassign', sameFailureBefore: 2 });
    expect(receipt.offered).not.toContain(REWORK_ID); // the same idea was never on the menu
  });

  it('stops and asks instead when starting over would cost a large share of the budget', () => {
    // The same wall, but the piece has already cost 200k of 500k: a from-scratch
    // attempt is not worth that, and neither is the idea that keeps failing.
    const { decision } = decideAssignmentRecovery({
      context: context(feedbackFor(NPM), [feedbackFor(NPM)]),
      state: state({ consumed: 200_000, progress: 0.02, evidence: 3 }), canReassign: true,
    });
    expect(decision.action).toBe('escalate');
  });

  it('does not treat a second refusal as the same idea when the child made real progress in between', () => {
    const { decision, receipt } = decideAssignmentRecovery({
      context: context(feedbackFor(NPM), [feedbackFor(NPM)]),
      state: state({ consumed: 200_000, progress: 0.3, evidence: 3 }), canReassign: true,
    });
    expect(receipt.sameFailureBefore).toBe(1);
    expect(decision.action).toBe('rework');
  });

  it('is not offered reassignment when a different owner is not permitted, so it cannot choose it', () => {
    const { decision, receipt } = decideAssignmentRecovery({
      context: context(feedbackFor(NPM), [feedbackFor(NPM), feedbackFor(NPM)]),
      state: state({ consumed: 60_000, progress: 0.02, evidence: 2 }), canReassign: false,
    });
    expect(decision.action).toBe('escalate');
    expect(receipt.offered).not.toContain(REASSIGN_ID);
  });

  it('does not count a refusal for something else as the same wall', () => {
    const different = decideAssignmentRecovery({
      context: context(feedbackFor(NPM), [feedbackFor('tsc is clean'), feedbackFor('lint is clean')]),
      state: state({ consumed: 300_000, progress: 0.4, evidence: 3 }), canReassign: true,
    });
    expect(different.receipt.sameFailureBefore).toBe(0);
    expect(different.decision.action).toBe('rework');
  });

  it('stops and asks when the child has established nothing and neither another revision nor a fresh start would pay', () => {
    const { decision } = decideAssignmentRecovery({
      context: context(feedbackFor(NPM)), state: state({ consumed: 200_000, progress: 0, evidence: 0 }), canReassign: true,
    });
    expect(decision.action).toBe('escalate');
    if (decision.action !== 'escalate') throw new Error('unreachable');
    expect(decision.reason).toMatch(/not worth its cost/);
  });

  it('defers to the default — the same child, reworked — where nothing has been measured', () => {
    // No tokens consumed: the market has no basis to overrule. Escalating here
    // would silently turn off same-child rework for any runtime that records no
    // usage.
    const { decision, receipt } = decideAssignmentRecovery({
      context: context(feedbackFor(NPM)), state: state({ consumed: 0, progress: 0 }), canReassign: true,
    });
    expect(decision).toEqual({ action: 'rework' });
    expect(receipt.reasonCodes).toContain('market:no_measurement');
  });

  it('cannot accept: whatever it says, it is a way of continuing or stopping', () => {
    const actions = new Set<string>();
    for (const same of [0, 1, 2, 3]) {
      for (const consumed of [1_000, 60_000, 300_000, 490_000]) {
        for (const progress of [0, 0.3, 0.9]) {
          const earlier = Array.from({ length: same }, () => feedbackFor(NPM));
          actions.add(decideAssignmentRecovery({
            context: context(feedbackFor(NPM), earlier), state: state({ consumed, progress, evidence: 2 }), canReassign: true,
          }).decision.action);
        }
      }
    }
    expect([...actions].every((action) => ['rework', 'reassign', 'escalate'].includes(action))).toBe(true);
  });

  it('is deterministic: the same situation gets the same decision', () => {
    const run = () => decideAssignmentRecovery({
      context: context(feedbackFor(NPM), [feedbackFor(NPM)]), state: state({ consumed: 300_000, progress: 0.1, evidence: 2 }),
      canReassign: true, decisionId: 'fixed',
    });
    expect(run()).toEqual(run());
  });

  it('records what it considered and why, so the decision can be audited', () => {
    const { receipt } = decideAssignmentRecovery({
      context: context(feedbackFor(NPM)), state: state({ progress: 0.5, evidence: 4 }), canReassign: true, decisionId: 'd9',
    });
    expect(receipt.decisionId).toBe('d9');
    expect(receipt.failureSignature).toBe(failureSignatureOf(feedbackFor(NPM)));
    expect(receipt.reasonCodes.length).toBeGreaterThan(0);
  });

  it('does not offer a fresh owner the remaining token budget cannot fund', () => {
    // 420k of 500k spent: a from-scratch attempt at that cost cannot fit in 80k.
    const { decision, receipt } = decideAssignmentRecovery({
      context: context(feedbackFor(NPM), [feedbackFor(NPM), feedbackFor(NPM)]),
      state: state({ consumed: 420_000, progress: 0.02, evidence: 2 }), canReassign: true,
    });
    expect(receipt.offered).not.toContain(REASSIGN_ID);
    expect(decision.action).toBe('escalate');
  });

  it('will not choose a fresh owner the child\'s own dollars cannot fund', () => {
    // Cheap in tokens, but the child has $0.20 of $2.50 left and a fresh owner
    // would cost more than that in dollars: the market rejects it on the money.
    const { decision } = decideAssignmentRecovery({
      context: context(feedbackFor(NPM), [feedbackFor(NPM), feedbackFor(NPM)]),
      state: state({ consumed: 60_000, progress: 0.02, evidence: 2, budgetUsd: 2.5, spentUsd: 2.3 }), canReassign: true,
    });
    expect(decision.action).not.toBe('reassign');
  });
});
