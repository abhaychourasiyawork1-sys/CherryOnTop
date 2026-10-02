// D2 (bench/governor/h26/DESIGN.md §2): a task turn budget with a retry reservation.
import { afterEach, describe, expect, it } from 'vitest';
import { dispatchTurnCap, retryReservation, retryReservationEnabled, RETRY_RESERVATION_SHARE } from './policy.js';
import { evaluateSpendGuard } from './spend-guard.js';

const T = 80;
afterEach(() => { delete process.env.ORG_TURN_RETRY_RESERVATION; });

describe('D2 turn budgeting', () => {
  it('T = 80 gives R = 20, a first cap of 60, and a retry with the reservation left', () => {
    expect(RETRY_RESERVATION_SHARE).toBe(0.25);
    expect(retryReservation(T)).toBe(20);
    expect(dispatchTurnCap({ taskTurnBudget: T, turnsUsed: 0, priorExecuteDispatches: 0 })).toBe(60);
    expect(dispatchTurnCap({ taskTurnBudget: T, turnsUsed: 60, priorExecuteDispatches: 1 })).toBe(20);
  });

  it('R is the ceiling of a quarter, at every boundary condition', () => {
    expect(retryReservation(1)).toBe(1);
    expect(retryReservation(4)).toBe(1);
    expect(retryReservation(5)).toBe(2);
    expect(retryReservation(81)).toBe(21);
    expect(dispatchTurnCap({ taskTurnBudget: 1, turnsUsed: 0, priorExecuteDispatches: 0 })).toBe(0);
  });

  it('the first dispatch can never consume the whole task budget and make the retry impossible', () => {
    for (const used of [0, 2, 10]) {
      const cap1 = dispatchTurnCap({ taskTurnBudget: T, turnsUsed: used, priorExecuteDispatches: 0 })!;
      // Even an agent that spends its full cap (plus turns spent before it,
      // e.g. a plan pass) leaves the reservation for the retry …
      const afterFirst = used + cap1;
      expect(T - afterFirst).toBeGreaterThanOrEqual(retryReservation(T));
      // … so the spend guard, checking the task total against T, lets the retry run.
      const guard = evaluateSpendGuard({
        spentUsd: 0, spendCapUsd: 0, turns: afterFirst, softTurnTarget: 200, hardTurnCap: T,
        explorationSignal: 0.5, progressSignal: 0.5, repeatedFailureSignal: 0,
      });
      expect(guard.state === 'STOP' && guard.hard).toBe(false);
      expect(dispatchTurnCap({ taskTurnBudget: T, turnsUsed: afterFirst, priorExecuteDispatches: 1 })).toBeGreaterThan(0);
    }
  });

  it('later dispatches get exactly the turns left, and none once T is spent', () => {
    expect(dispatchTurnCap({ taskTurnBudget: T, turnsUsed: 70, priorExecuteDispatches: 2 })).toBe(10);
    expect(dispatchTurnCap({ taskTurnBudget: T, turnsUsed: 80, priorExecuteDispatches: 2 })).toBe(0);
    expect(dispatchTurnCap({ taskTurnBudget: T, turnsUsed: 85, priorExecuteDispatches: 3 })).toBe(0);
    const guard = evaluateSpendGuard({
      spentUsd: 0, spendCapUsd: 0, turns: 80, softTurnTarget: 200, hardTurnCap: T,
      explorationSignal: 0.5, progressSignal: 0.5, repeatedFailureSignal: 0,
    });
    expect(guard.state === 'STOP' && guard.hard).toBe(true);
  });

  it('uncapped stays uncapped', () => {
    expect(dispatchTurnCap({ taskTurnBudget: undefined, turnsUsed: 50, priorExecuteDispatches: 0 })).toBeUndefined();
  });

  it('is an environment parameter: off unless set, and nothing in it can see an experiment arm', () => {
    expect(retryReservationEnabled()).toBe(false);
    process.env.ORG_TURN_RETRY_RESERVATION = 'on';
    expect(retryReservationEnabled()).toBe(true);
    // Arm parity: the cap is a function of (T, turns used, prior dispatches)
    // alone — no assignment, mask or governor variant is an input.
    expect(dispatchTurnCap.length).toBe(1);
    const input = { taskTurnBudget: T, turnsUsed: 0, priorExecuteDispatches: 0 };
    expect(dispatchTurnCap({ ...input })).toBe(dispatchTurnCap({ ...input }));
  });
});
