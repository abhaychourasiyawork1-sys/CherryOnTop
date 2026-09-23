import { describe, it, expect } from 'vitest';
import {
  compareTrajectory, unproductiveRepetition, signalGap, EMPTY_SNAPSHOT,
  type ExecutionSnapshot,
} from './trajectory.js';

const snap = (over: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot => ({ ...EMPTY_SNAPSHOT, ...over });

describe('productive exploration is not a bad trajectory', () => {
  it('scores repetition that keeps learning at zero', () => {
    // Twelve more searches, all in the same corner of the repository — and six
    // new facts to show for them. This is an investigation doing its job.
    const before = snap({
      sequence: 1, totalActions: 10, searchTargets: ['auth', 'session'],
      knownEvidence: ['e1', 'e2'], tokensConsumed: 5_000,
    });
    const after = snap({
      sequence: 2, totalActions: 22, searchTargets: ['auth', 'session', 'refresh', 'cookie'],
      knownEvidence: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8'], tokensConsumed: 12_000,
    });
    const t = compareTrajectory(before, after);
    expect(t.explorationPressure).toBeGreaterThan(0);
    expect(t.informationGain).toBeGreaterThan(0.5);
    expect(unproductiveRepetition(t)).toBe(0);
  });

  it('does not punish high exploration on its own', () => {
    const t = compareTrajectory(
      snap({ totalActions: 0, knownEvidence: [] }),
      snap({ totalActions: 20, searchTargets: Array.from({ length: 20 }, (_, i) => `s${i}`), knownEvidence: ['a', 'b'] }),
    );
    expect(t.explorationPressure).toBe(1);
    expect(t.failurePressure).toBe(0);
    // Twenty distinct searches overlap nothing from an empty previous state.
    expect(t.stateSimilarity).toBe(0);
  });
});

describe('low-value exploration raises pressure', () => {
  it('flags repeated state with rising cost and no information gain', () => {
    const targets = ['src/auth/session.ts', 'refreshSession', 'src/auth/token.ts'];
    const before = snap({ sequence: 1, totalActions: 10, searchTargets: targets, knownEvidence: ['e1', 'e2'], tokensConsumed: 5_000 });
    const after = snap({ sequence: 2, totalActions: 24, searchTargets: targets, knownEvidence: ['e1', 'e2'], tokensConsumed: 40_000 });

    const t = compareTrajectory(before, after);
    expect(t.stateSimilarity).toBe(1);
    expect(t.informationGain).toBe(0);
    expect(t.costVelocity).toBeGreaterThan(0);
    expect(unproductiveRepetition(t)).toBe(1);
  });

  it('separates the same failure repeating from two different problems', () => {
    const loop = compareTrajectory(
      snap({ totalActions: 4, failureSignatures: ['Bash#tsc#TS2345'] }),
      snap({ totalActions: 8, failureSignatures: ['Bash#tsc#TS2345', 'Bash#tsc#TS2345', 'Bash#tsc#TS2345', 'Bash#tsc#TS2345'] }),
    );
    const working = compareTrajectory(
      snap({ totalActions: 4, failureSignatures: ['Bash#tsc#TS2345'] }),
      snap({ totalActions: 8, failureSignatures: ['Bash#eslint#no-unused', 'Bash#vitest#assert', 'Bash#tsc#TS2741', 'Bash#tsc#TS2739'] }),
    );
    expect(loop.failurePressure).toBeGreaterThan(working.failurePressure);
  });

  it('does not raise failure pressure for one failure among many actions', () => {
    const t = compareTrajectory(
      snap({ totalActions: 0 }),
      snap({ totalActions: 100, failureSignatures: ['Bash#tsc#TS2345'] }),
    );
    expect(t.failurePressure).toBeLessThan(0.1);
  });

  it('treats a failure that survived the interval as strong evidence', () => {
    const t = compareTrajectory(
      snap({ totalActions: 4, failureSignatures: ['Bash#tsc#TS2345'] }),
      snap({ totalActions: 6, failureSignatures: ['Bash#tsc#TS2345'] }),
    );
    expect(t.failurePressure).toBeGreaterThan(0);
  });
});

describe('the fingerprint is about subjects, not calls', () => {
  it('reads a run that moved from failing in a file to searching it as unmoved', () => {
    const t = compareTrajectory(
      snap({ totalActions: 5, failureSignatures: ['Bash#src/a.ts#error'], activeTargets: ['src/a.ts'] }),
      snap({ totalActions: 9, searchTargets: ['src/a.ts'], activeTargets: ['src/a.ts'] }),
    );
    expect(t.stateSimilarity).toBeGreaterThan(0);
  });

  it('reads a run that moved to a different part of the repository as moved', () => {
    const t = compareTrajectory(
      snap({ totalActions: 5, activeTargets: ['src/auth/session.ts'], searchTargets: ['refreshSession'] }),
      snap({ totalActions: 9, activeTargets: ['src/db/queries/nodes.ts'], searchTargets: ['insertNode'] }),
    );
    expect(t.stateSimilarity).toBe(0);
  });

  it('calls two empty fingerprints unknown rather than identical', () => {
    expect(compareTrajectory(snap(), snap()).stateSimilarity).toBe(0);
  });
});

describe('progress and cost', () => {
  it('measures progress over the interval when one happened', () => {
    const t = compareTrajectory(
      snap({ totalActions: 10, productiveActions: 0 }),
      snap({ totalActions: 20, productiveActions: 8 }),
    );
    expect(t.progress).toBeCloseTo(0.8);
  });

  it('falls back to the whole run when nothing happened in the interval', () => {
    // A decision cycle firing twice between two tool calls must not read as a
    // run that stopped producing.
    const same = snap({ totalActions: 20, productiveActions: 10 });
    expect(compareTrajectory(same, same).progress).toBeCloseTo(0.5);
  });

  it('reports cost per action taken', () => {
    const t = compareTrajectory(
      snap({ totalActions: 10, tokensConsumed: 1000 }),
      snap({ totalActions: 20, tokensConsumed: 41_000 }),
    );
    expect(t.costVelocity).toBeCloseTo(4000);
  });

  it('reports the raw spend when no action was taken for it', () => {
    const t = compareTrajectory(
      snap({ totalActions: 10, tokensConsumed: 1000 }),
      snap({ totalActions: 10, tokensConsumed: 6000 }),
    );
    expect(t.costVelocity).toBe(5000);
  });

  it('never reports a negative interval from an out-of-order snapshot', () => {
    const t = compareTrajectory(
      snap({ totalActions: 20, productiveActions: 10, tokensConsumed: 9000 }),
      snap({ totalActions: 10, productiveActions: 2, tokensConsumed: 1000 }),
    );
    expect(t.costVelocity).toBeGreaterThanOrEqual(0);
    expect(t.progress).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic and total over empty input', () => {
    expect(compareTrajectory(EMPTY_SNAPSHOT, EMPTY_SNAPSHOT)).toEqual({
      progress: 0, informationGain: 0, explorationPressure: 0,
      failurePressure: 0, stateSimilarity: 0, costVelocity: 0,
    });
  });
});

describe('signalGap', () => {
  it('is zero when the dimensions agree or the second exceeds the first', () => {
    expect(signalGap(0.5, 0.5)).toBe(0);
    expect(signalGap(0.2, 0.9)).toBe(0);
  });

  it('is the difference when the first exceeds the second', () => {
    expect(signalGap(0.9, 0.4)).toBeCloseTo(0.5);
  });
});
