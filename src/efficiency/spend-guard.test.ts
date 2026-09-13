import { describe, it, expect } from 'vitest';
import { evaluateSpendGuard, type SpendGuardInput } from './spend-guard.js';

const guard = (over: Partial<SpendGuardInput> = {}) => evaluateSpendGuard({
  spentUsd: 0, spendCapUsd: 10, turns: 0, softTurnTarget: 20, hardTurnCap: 45,
  explorationSignal: 0.3, progressSignal: 0.7, ...over,
});

describe('evaluateSpendGuard — the four states', () => {
  it('is GREEN on a task that has barely started', () => {
    const g = guard();
    expect(g.state).toBe('GREEN');
    expect(g.reason).toBeNull();
  });

  it('goes AMBER past the soft target', () => {
    expect(guard({ turns: 25 }).state).toBe('AMBER');
  });

  it('goes AMBER past 60% of the spend cap', () => {
    expect(guard({ spentUsd: 6.5 }).state).toBe('AMBER');
  });

  it('goes RED past 85% of the spend cap', () => {
    const g = guard({ spentUsd: 9 });
    expect(g.state).toBe('RED');
    expect(g.reason).toMatch(/spend cap/);
  });

  it('goes RED close to the turn cap', () => {
    expect(guard({ turns: 41 }).state).toBe('RED');
  });

  it('STOPs at the spend cap', () => {
    const g = guard({ spentUsd: 10 });
    expect(g.state).toBe('STOP');
    expect(g.reason).toMatch(/Spend cap reached/);
  });

  it('escalates monotonically as spend climbs', () => {
    const order = ['GREEN', 'AMBER', 'RED', 'STOP'];
    const seen = [0, 6.5, 9, 10].map((spentUsd) => order.indexOf(guard({ spentUsd }).state));
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });
});

describe('evaluateSpendGuard — precedence', () => {
  it('stops on spend even with most of the turn allowance left', () => {
    const g = guard({ spentUsd: 12, turns: 2, hardTurnCap: 45 });
    expect(g.state).toBe('STOP');
    expect(g.reason).toMatch(/Spend cap/);
  });

  it('stops on the turn cap even when spend telemetry is missing entirely', () => {
    const g = guard({ spentUsd: 0, spendCapUsd: 0, turns: 45, hardTurnCap: 45 });
    expect(g.state).toBe('STOP');
    expect(g.reason).toMatch(/Turn cap reached/);
  });

  it('treats a zero cap as "nobody costed this", not as "out of money"', () => {
    expect(guard({ spendCapUsd: 0, spentUsd: 500, turns: 1 }).state).toBe('GREEN');
  });
});

describe('evaluateSpendGuard — a high turn count is not a verdict', () => {
  it('does not stop a productive run that is simply taking many turns', () => {
    const g = guard({ turns: 40, hardTurnCap: 60, spentUsd: 7, progressSignal: 0.8, explorationSignal: 0.3 });
    expect(g.state).not.toBe('STOP');
  });

  it('does not stop an expensive but productive debugging trajectory', () => {
    const g = guard({ turns: 42, hardTurnCap: 60, spentUsd: 9.4, progressSignal: 0.6, explorationSignal: 0.5 });
    expect(g.state).toBe('RED');
  });

  it('stops a trajectory that is searching, not working — but only with all three conditions', () => {
    const stalled = { turns: 30, hardTurnCap: 60, spentUsd: 6, progressSignal: 0, explorationSignal: 0.95 };
    expect(guard(stalled).state).toBe('STOP');
    // Any one condition relaxed and it is no longer a stop.
    expect(guard({ ...stalled, progressSignal: 0.4 }).state).not.toBe('STOP');
    expect(guard({ ...stalled, explorationSignal: 0.5 }).state).not.toBe('STOP');
    expect(guard({ ...stalled, spentUsd: 1 }).state).not.toBe('STOP');
    expect(guard({ ...stalled, turns: 5 }).state).not.toBe('STOP');
  });

  it('never stalls-out a task nobody costed — that would fire on every runtime reporting no cost', () => {
    const g = guard({ spendCapUsd: 0, turns: 30, hardTurnCap: 60, progressSignal: 0, explorationSignal: 1 });
    expect(g.state).not.toBe('STOP');
  });
});

describe('evaluateSpendGuard — totality', () => {
  it('answers something safe for nonsense input rather than throwing', () => {
    const g = evaluateSpendGuard({
      spentUsd: NaN, spendCapUsd: NaN, turns: NaN, softTurnTarget: NaN,
      hardTurnCap: NaN, explorationSignal: NaN, progressSignal: NaN,
    });
    expect(['GREEN', 'AMBER', 'RED', 'STOP']).toContain(g.state);
    expect(Number.isFinite(g.spentUsd)).toBe(true);
  });

  it('always names a reason when it is not GREEN', () => {
    for (const over of [{ turns: 25 }, { spentUsd: 9 }, { spentUsd: 10 }]) {
      const g = guard(over);
      expect(g.reason).toBeTruthy();
    }
  });

  it('is deterministic', () => {
    expect(guard({ spentUsd: 7, turns: 22 })).toEqual(guard({ spentUsd: 7, turns: 22 }));
  });
});
