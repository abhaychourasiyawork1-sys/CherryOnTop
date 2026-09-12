import { describe, it, expect } from 'vitest';
import { replayDecision, replayNode, type ReplayableDecision } from './replay.js';

/** A decision as `decideExecution` actually records one: the economics terms it
 *  ran, the signals that fed it, and the score it reached. */
const delegated: ReplayableDecision = {
  id: 'd1',
  type: 'execution_decision',
  outcome: 'DELEGATE',
  breakdown: {
    breadth_terms: 1, separate_items: 0, distinct_work_types: 1,
    named_single_targets: 0, decomposition_score: 2,
    estimatedValue: 0.7, modelCost: 0.1, latencyCost: 0.05,
    coordinationCost: 0.15, verificationCost: 0.1, riskPenalty: 0,
    threshold: 0.3, score: 0.29999999999999993,
  },
};

describe('replaying a recorded decision', () => {
  it('reproduces the outcome from the inputs that were written down', () => {
    // The whole auditability claim in one assertion: the decision was
    // arithmetic, the arithmetic was recorded, and it still runs.
    const replay = replayDecision(delegated);
    expect(replay.reproduced).toBe(true);
    expect(replay.replayedOutcome).toBe('DELEGATE');
    expect(replay.replayedScore).toBeCloseTo(0.3, 9);
  });

  it("says so when today's code would decide differently", () => {
    // The point of replaying rather than re-reading. If a weight or a threshold
    // moves, every past decision that turned on it stops reproducing, and that
    // is a fact worth surfacing rather than discovering in production.
    const drifted = { ...delegated, breakdown: { ...delegated.breakdown, threshold: 0.9 } };
    const replay = replayDecision(drifted);
    expect(replay.reproduced).toBe(false);
    expect(replay.replayedOutcome).toBe('SELF_EXECUTE');
    expect(replay.reason).toMatch(/DELEGATE.*SELF_EXECUTE/);
  });

  it('names the single change that would have flipped it', () => {
    // Only possible because the decision is arithmetic. A model asked to explain
    // itself tells a story; this names the term and the margin.
    expect(replayDecision(delegated).counterfactual?.term).toBe('coordinationCost');
    expect(replayDecision(delegated).counterfactual?.margin).toBeCloseTo(0, 9);
  });

  it('refuses to invent a replay for a decision it cannot re-run', () => {
    // A rule-based outcome has a score but no formula behind it, and a decision
    // recorded before economics existed has neither. Reporting "reproduced" for
    // either would be claiming an audit that never happened.
    const ruled: ReplayableDecision = {
      id: 'd2', type: 'execution_decision', outcome: 'SELF_EXECUTE',
      breakdown: { score: 0, reason_no_spawn_authority: 1 },
    };
    expect(replayDecision(ruled).replayable).toBe(false);
    expect(replayDecision(ruled).reproduced).toBe(false);

    const runtime: ReplayableDecision = {
      id: 'd3', type: 'runtime_selection', outcome: 'claude-code', breakdown: { score: 1 },
    };
    expect(replayDecision(runtime).replayable).toBe(false);
  });
});

describe('replaying a whole node', () => {
  it('summarizes how many of its decisions still reproduce', () => {
    const summary = replayNode('n1', [
      delegated,
      { ...delegated, id: 'd2', breakdown: { ...delegated.breakdown, threshold: 0.9 } },
      { id: 'd3', type: 'execution_decision', outcome: 'SELF_EXECUTE', breakdown: { score: 0, reason_no_spawn_authority: 1 } },
    ]);
    expect(summary.nodeId).toBe('n1');
    expect(summary.total).toBe(3);
    expect(summary.replayable).toBe(2);
    expect(summary.reproduced).toBe(1);
    expect(summary.diverged.map((d) => d.id)).toEqual(['d2']);
  });

  it('is vacuously true for a node that decided nothing', () => {
    const summary = replayNode('n1', []);
    expect(summary.total).toBe(0);
    expect(summary.allReproduced).toBe(true);
  });
});
