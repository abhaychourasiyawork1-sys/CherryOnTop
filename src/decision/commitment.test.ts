import { describe, it, expect } from 'vitest';
import {
  commitAction, settleCommitment, cancelCommitment, predictionError, reservationFor, CommitmentBook,
} from './commitment.js';
import { chooseEconomicAction } from './engine.js';
import { actionCandidate } from './actions.js';
import { initialEconomicState, normalizeEconomicState, type EconomicState } from './state.js';
import { availableTokens } from './transition.js';

function state(over: Partial<EconomicState> = {}): EconomicState {
  const base = initialEconomicState({ goal: 'g', totalTokenBudget: 10_000 });
  return normalizeEconomicState({ ...base, version: 17, ...over });
}

const read = (id = 'read', tokenCost = 2_000) => actionCandidate({
  id, kind: 'acquire_evidence', capability: 'evidence.read-file',
  expectedTokenBenefit: tokenCost * 3, tokenCost, confidence: 1,
});

describe('a decision never moves state; a commitment does', () => {
  it('leaves the state it decided against untouched', () => {
    const s = state();
    const before = JSON.stringify(s);
    chooseEconomicAction({ state: s, candidates: [read()] });
    expect(JSON.stringify(s)).toBe(before);
  });

  it('reserves at commitment, and advances the version', () => {
    const s = state();
    const decision = chooseEconomicAction({ state: s, candidates: [read()] });
    const result = commitAction(s, decision);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.version).toBe(18);
    expect(result.state.resources.reservedTokens).toBe(result.commitment.reservedResources.tokens);
    expect(result.commitment.reservedResources.tokens).toBeGreaterThanOrEqual(2_000);
    expect(availableTokens(result.state)).toBe(10_000 - result.commitment.reservedResources.tokens);
    // The original is still the original.
    expect(s.resources.reservedTokens).toBe(0);
  });

  it('reserves more for an action the market was unsure of', () => {
    const s = state();
    const sure = chooseEconomicAction({ state: s, candidates: [read()] });
    const unsure = chooseEconomicAction({ state: s, candidates: [{ ...read(), confidence: 0.3 }] });
    expect(reservationFor(unsure, s).tokens).toBeGreaterThanOrEqual(reservationFor(sure, s).tokens);
  });
});

describe('a stale decision never executes', () => {
  it('refuses a decision made against an older version', () => {
    const decided = chooseEconomicAction({ state: state({ version: 17 }), candidates: [read()] });
    const result = commitAction(state({ version: 18 }), decided);
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'stale_decision' }));
  });

  it('refuses a blocked decision', () => {
    const stopped = state({ constraints: { qualityFloor: 0.7, hardStop: true } });
    const decision = chooseEconomicAction({ state: stopped, candidates: [] });
    // Stop is feasible under a hard stop, so this is not blocked — but a
    // market with nothing feasible is, and must not be committed.
    const blocked = chooseEconomicAction({
      state: state(), candidates: [actionCandidate({ id: 'x', kind: 'continue', capability: 'c', metadata: { infeasible: 'down' } })],
    });
    expect(decision.blocked).toBe(false);
    expect(blocked.blocked).toBe(true);
    expect(commitAction(state(), blocked)).toEqual(expect.objectContaining({ ok: false, reason: 'blocked' }));
  });
});

describe('reservations prevent double spending', () => {
  it('two decisions against the same state cannot both commit', () => {
    const s = state();
    const a = chooseEconomicAction({ state: s, candidates: [read('a', 6_000)] });
    const b = chooseEconomicAction({ state: s, candidates: [read('b', 6_000)] });
    const first = commitAction(s, a);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // b was decided against v17; the state is now v18. Stale, recomputed.
    expect(commitAction(first.state, b)).toEqual(expect.objectContaining({ reason: 'stale_decision' }));
    // Recomputed against the reserved state, the second read no longer fits.
    const again = chooseEconomicAction({ state: first.state, candidates: [read('b', 6_000)] });
    expect(again.action.id).not.toBe('b');
    expect(again.reasonCodes).toContain('rejected:b:insufficient_budget');
  });

  it('refuses an envelope that does not fit what is left after reservations', () => {
    const tight = state({ resources: { ...state().resources, reservedTokens: 9_500 } });
    const decision = { ...chooseEconomicAction({ state: state(), candidates: [read('r', 2_000)] }), stateVersion: tight.version };
    expect(commitAction(tight, decision)).toEqual(expect.objectContaining({ ok: false, reason: 'insufficient_resources' }));
  });

  it('keeps the null action committable on a run that has spent everything', () => {
    const broke = state({ resources: { ...state().resources, consumedTokens: 10_000 } });
    const decision = chooseEconomicAction({ state: broke, candidates: [] });
    expect(commitAction(broke, decision).ok).toBe(true);
  });
});

describe('settlement', () => {
  it('replaces the reservation with what was actually spent', () => {
    const s = state();
    const committed = commitAction(s, chooseEconomicAction({ state: s, candidates: [read()] }));
    if (!committed.ok) throw new Error('expected a commitment');
    const settled = settleCommitment(committed.state, committed.commitment, { tokens: 1_500, usd: 0.01, latencyMs: 10, succeeded: true });
    expect(settled.resources.reservedTokens).toBe(0);
    expect(settled.resources.consumedTokens).toBe(1_500);
    expect(settled.version).toBe(committed.state.version + 1);
  });

  it('releases a cancelled reservation without charging anything', () => {
    const s = state();
    const committed = commitAction(s, chooseEconomicAction({ state: s, candidates: [read()] }));
    if (!committed.ok) throw new Error('expected a commitment');
    const cancelled = cancelCommitment(committed.state, committed.commitment);
    expect(cancelled.resources.reservedTokens).toBe(0);
    expect(cancelled.resources.consumedTokens).toBe(0);
  });

  it('never mints budget by settling twice', () => {
    const s = state();
    const committed = commitAction(s, chooseEconomicAction({ state: s, candidates: [read()] }));
    if (!committed.ok) throw new Error('expected a commitment');
    const once = cancelCommitment(committed.state, committed.commitment);
    expect(cancelCommitment(once, committed.commitment).resources.reservedTokens).toBe(0);
  });

  it('reports actual minus predicted, always in that order', () => {
    const s = state();
    const committed = commitAction(s, chooseEconomicAction({ state: s, candidates: [read()] }));
    if (!committed.ok) throw new Error('expected a commitment');
    const error = predictionError(committed.commitment, { tokens: 0, usd: 1, latencyMs: 0, succeeded: false });
    expect(error.costUsd).toBeGreaterThan(0);
    expect(error.success).toBeLessThan(0);
  });
});

describe('the process-level book', () => {
  it('folds its reservations and epoch into the state storage cannot see', () => {
    const book = new CommitmentBook();
    const observed = state();
    const view = book.view('n', observed);
    const decision = chooseEconomicAction({ state: view, candidates: [read('a', 6_000)] });
    expect(book.commit('n', book.view('n', observed), decision).ok).toBe(true);
    const after = book.view('n', observed);
    expect(after.version).toBe(observed.version + 1);
    expect(after.resources.reservedTokens).toBeGreaterThanOrEqual(6_000);

    // A second decision made against the old view is stale against the new one.
    const late = chooseEconomicAction({ state: view, candidates: [read('b', 1_000)] });
    expect(book.commit('n', book.view('n', observed), late)).toEqual(expect.objectContaining({ reason: 'stale_decision' }));
  });

  it('releases on settle and on cancel, and forgets a finished scope', () => {
    const book = new CommitmentBook();
    const observed = state();
    const decision = chooseEconomicAction({ state: book.view('n', observed), candidates: [read()] });
    const result = book.commit('n', book.view('n', observed), decision);
    if (!result.ok) throw new Error('expected a commitment');
    expect(book.openCommitments('n')).toHaveLength(1);
    expect(book.settle('n', result.commitment.commitmentId, { tokens: 1, usd: 0, latencyMs: 0, succeeded: true })).not.toBeNull();
    expect(book.openCommitments('n')).toHaveLength(0);
    expect(book.view('n', observed).resources.reservedTokens).toBe(0);
    book.forget('n');
    expect(book.view('n', observed).version).toBe(observed.version);
  });
});
