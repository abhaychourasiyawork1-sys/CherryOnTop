import { describe, it, expect } from 'vitest';
import { chooseEconomicAction } from './engine.js';
import { actionCandidate, type ActionCandidate, type ActionKind } from './actions.js';
import { initialEconomicState, normalizeEconomicState, type EconomicState } from './state.js';

function state(over: Partial<EconomicState> = {}): EconomicState {
  const base = initialEconomicState({ goal: 'g', totalTokenBudget: 10_000, qualityFloor: 0.7 });
  return normalizeEconomicState({
    ...base, ...over,
    resources: { ...base.resources, latencyBudgetMs: 600_000, ...over.resources },
  });
}

const of = (id: string, kind: ActionKind, over: Partial<ActionCandidate> = {}) =>
  actionCandidate({ id, kind, capability: `cap.${kind}`, confidence: 0.9, ...over });

/** The same candidate set every time, with one member made decisively the best.
 *  No task category is attached to any of them, and none is needed: the winner
 *  changes because the *numbers* change, which is the architectural claim. */
function mixedCandidates(best: ActionKind, boost: Partial<ActionCandidate>): ActionCandidate[] {
  const kinds: ActionKind[] = [
    'acquire_evidence', 'validate', 'explore', 'parallelize', 'recover', 'continue', 'stop',
  ];
  return kinds.map((kind) =>
    kind === best
      ? of(`c-${kind}`, kind, boost)
      : of(`c-${kind}`, kind, { expectedTokenBenefit: 10, tokenCost: 5 }));
}

describe('chooseEconomicAction selects generically', () => {
  it('picks evidence acquisition when that is what the numbers favour', () => {
    const d = chooseEconomicAction({
      state: state(),
      candidates: mixedCandidates('acquire_evidence', { expectedTokenBenefit: 6000, tokenCost: 400 }),
    });
    expect(d.action.kind).toBe('acquire_evidence');
  });

  it('picks validation when quality is what is on offer', () => {
    const d = chooseEconomicAction({
      state: state(),
      candidates: mixedCandidates('validate', { expectedQualityBenefit: 0.6, tokenCost: 500 }),
    });
    expect(d.action.kind).toBe('validate');
  });

  it('picks exploration when information gain carries a token benefit with it', () => {
    const d = chooseEconomicAction({
      state: state(),
      candidates: mixedCandidates('explore', { expectedInformationGain: 0.8, expectedTokenBenefit: 5000, tokenCost: 900 }),
    });
    expect(d.action.kind).toBe('explore');
  });

  it('picks parallelization when latency is what is on offer', () => {
    const d = chooseEconomicAction({
      state: state(),
      candidates: mixedCandidates('parallelize', { expectedLatencyBenefit: 550_000, tokenCost: 200, coordinationCost: 100 }),
    });
    expect(d.action.kind).toBe('parallelize');
  });

  it('picks recovery when a retry is the profitable move', () => {
    const d = chooseEconomicAction({
      state: state({ trajectory: { ...state().trajectory, failurePressure: 0.9 } }),
      candidates: mixedCandidates('recover', { expectedProgress: 0.8, expectedTokenBenefit: 7000, tokenCost: 1500 }),
    });
    expect(d.action.kind).toBe('recover');
  });

  it('picks continuation when nothing beats letting the agent get on with it', () => {
    const d = chooseEconomicAction({
      state: state(),
      candidates: mixedCandidates('continue', { expectedProgress: 0.5, expectedTokenBenefit: 3000 }),
    });
    expect(d.action.kind).toBe('continue');
  });

  it('picks stop when the state carries a hard stop', () => {
    const d = chooseEconomicAction({
      state: state({ constraints: { qualityFloor: 0.7, hardStop: true } }),
      candidates: mixedCandidates('acquire_evidence', { expectedTokenBenefit: 90_000, tokenCost: 1 }),
    });
    expect(d.action.kind).toBe('stop');
    expect(d.reasonCodes).toContain('hard_stop');
  });

  it('reaches every one of those verdicts from one candidate set shape', () => {
    // The same seven kinds each win in turn, with no branch on task shape
    // anywhere: only the economics differ between the seven cases above.
    const kinds = new Set([
      chooseEconomicAction({ state: state(), candidates: mixedCandidates('acquire_evidence', { expectedTokenBenefit: 6000 }) }).action.kind,
      chooseEconomicAction({ state: state(), candidates: mixedCandidates('validate', { expectedQualityBenefit: 0.6 }) }).action.kind,
      chooseEconomicAction({ state: state(), candidates: mixedCandidates('explore', { expectedTokenBenefit: 5000 }) }).action.kind,
    ]);
    expect(kinds.size).toBe(3);
  });
});

describe('hard constraints filter before ranking', () => {
  it('never chooses an unsafe action, however profitable', () => {
    const d = chooseEconomicAction({
      state: state(),
      candidates: [
        of('unsafe', 'acquire_evidence', { expectedTokenBenefit: 500_000, metadata: { unsafe: true } }),
        of('ok', 'acquire_evidence', { expectedTokenBenefit: 100, tokenCost: 10 }),
      ],
    });
    expect(d.action.id).toBe('ok');
  });

  it('never chooses an action that breaches the quality floor', () => {
    const d = chooseEconomicAction({
      state: state(),
      candidates: [
        of('cheap-and-wrong', 'explore', { expectedTokenBenefit: 500_000, qualityRisk: 0.6 }),
        of('sound', 'validate', { expectedQualityBenefit: 0.1, tokenCost: 50 }),
      ],
    });
    expect(d.action.id).toBe('sound');
  });

  it('never chooses an action the task cannot afford', () => {
    const broke = state({ resources: { ...state().resources, consumedTokens: 9900 } });
    const d = chooseEconomicAction({
      state: broke,
      candidates: [of('expensive', 'explore', { expectedTokenBenefit: 50_000, tokenCost: 5000 })],
    });
    expect(d.action.kind).toBe('continue');
  });
});

describe('deterministic ranking', () => {
  it('ranks by utility first', () => {
    const d = chooseEconomicAction({
      state: state(),
      candidates: [
        of('small', 'acquire_evidence', { expectedTokenBenefit: 1000, confidence: 1 }),
        of('large', 'acquire_evidence', { expectedTokenBenefit: 8000, confidence: 1 }),
      ],
    });
    expect(d.action.id).toBe('large');
  });

  it('breaks a utility tie on confidence', () => {
    const d = chooseEconomicAction({
      state: state(),
      candidates: [
        // Equal net utility by construction: benefit scaled so confidence*net matches.
        of('unsure', 'acquire_evidence', { expectedTokenBenefit: 4000, confidence: 0.5 }),
        of('sure', 'acquire_evidence', { expectedTokenBenefit: 2000, confidence: 1 }),
      ],
    });
    expect(d.action.id).toBe('sure');
    expect(d.reasonCodes).toContain('tie_broken_on_confidence');
  });

  it('breaks a remaining tie on the stable id, never on a task name', () => {
    const candidates = [
      of('zebra', 'acquire_evidence', { expectedTokenBenefit: 2000, confidence: 0.8 }),
      of('alpha', 'acquire_evidence', { expectedTokenBenefit: 2000, confidence: 0.8 }),
    ];
    expect(chooseEconomicAction({ state: state(), candidates }).action.id).toBe('alpha');
    // Input order must not change the answer.
    expect(chooseEconomicAction({ state: state(), candidates: [...candidates].reverse() }).action.id).toBe('alpha');
  });

  it('gives the same answer for the same state and candidates', () => {
    const candidates = mixedCandidates('validate', { expectedQualityBenefit: 0.5 });
    const a = chooseEconomicAction({ state: state(), candidates });
    const b = chooseEconomicAction({ state: state(), candidates });
    expect({ ...a, decisionId: '' }).toEqual({ ...b, decisionId: '' });
  });
});

describe('the conservative fallback', () => {
  it('continues when no candidate has positive justified utility', () => {
    const d = chooseEconomicAction({
      state: state(),
      candidates: [
        of('lossy', 'explore', { expectedTokenBenefit: 10, tokenCost: 5000 }),
        of('lossier', 'parallelize', { expectedTokenBenefit: 0, tokenCost: 9000 }),
      ],
    });
    expect(d.action.kind).toBe('continue');
    expect(d.reasonCodes).toContain('no_justified_opportunity');
  });

  it('continues when there are no candidates at all', () => {
    const d = chooseEconomicAction({ state: state(), candidates: [] });
    expect(d.action.kind).toBe('continue');
    expect(d.utility).toBe(0);
  });

  it('stops only when continuing is itself unsafe', () => {
    const stopped = state({ constraints: { qualityFloor: 0.7, hardStop: true } });
    expect(chooseEconomicAction({ state: stopped, candidates: [] }).action.kind).toBe('stop');
  });

  it('does not stop merely because the budget is gone', () => {
    const spent = state({ resources: { ...state().resources, consumedTokens: 10_000 } });
    expect(chooseEconomicAction({ state: spent, candidates: [] }).action.kind).toBe('continue');
  });

  it('prefers a supplied continue candidate over a synthetic one', () => {
    const d = chooseEconomicAction({
      state: state(),
      candidates: [of('mine', 'continue', { expectedTokenBenefit: 0, tokenCost: 0 })],
    });
    expect(d.action.id).toBe('mine');
  });
});

describe('decision provenance', () => {
  it('records the state version the decision was made against', () => {
    const s = state({ version: 17 });
    expect(chooseEconomicAction({ state: s, candidates: [] }).stateVersion).toBe(17);
  });

  it('gives every decision a distinct id', () => {
    const a = chooseEconomicAction({ state: state(), candidates: [] });
    const b = chooseEconomicAction({ state: state(), candidates: [] });
    expect(a.decisionId).not.toBe(b.decisionId);
  });

  it('carries the winning action reason codes plus the ranking outcome', () => {
    const d = chooseEconomicAction({
      state: state(),
      candidates: [
        of('win', 'acquire_evidence', { expectedTokenBenefit: 5000 }),
        of('lose', 'explore', { expectedTokenBenefit: 5000, qualityRisk: 0.9 }),
      ],
    });
    expect(d.reasonCodes).toContain('positive_utility');
    expect(d.reasonCodes).toContain('chosen_by_utility');
    // What it beat, and why the loser was not eligible, is part of the record.
    expect(d.reasonCodes).toContain('rejected:lose:quality_floor');
  });

  it('reports a confidence that never exceeds the orchestrator’s own', () => {
    const doubtful = state({ trajectory: { ...state().trajectory, orchestrationConfidence: 0.3 } });
    const d = chooseEconomicAction({
      state: doubtful,
      candidates: [of('win', 'acquire_evidence', { expectedTokenBenefit: 5000, confidence: 1 })],
    });
    expect(d.confidence).toBeLessThanOrEqual(0.3);
  });
});
