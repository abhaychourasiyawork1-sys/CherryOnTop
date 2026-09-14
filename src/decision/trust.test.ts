import { describe, it, expect } from 'vitest';
import { assessDecisionTrust, trustAdjusted, evidenceConfidenceOf } from './trust.js';
import { chooseEconomicAction } from './engine.js';
import { actionCandidate, type ActionCandidate, type ActionKind } from './actions.js';
import { initialEconomicState, normalizeEconomicState, type EconomicState } from './state.js';

function state(over: Partial<EconomicState> = {}): EconomicState {
  const base = initialEconomicState({ goal: 'g', totalTokenBudget: 100_000, qualityFloor: 0.7 });
  return normalizeEconomicState({
    ...base,
    trajectory: { ...base.trajectory, orchestrationConfidence: 0.9 },
    ...over,
  });
}

const of = (over: Partial<ActionCandidate> = {}) => actionCandidate({
  id: 'a', kind: 'acquire_evidence' as ActionKind, capability: 'evidence.read-file',
  confidence: 0.9, ...over,
});

const trust = (action = of(), s = state()) => assessDecisionTrust({ state: s, action });

describe('doubt narrows what may be done, rather than widening it', () => {
  it('leaves a free action untouched however little is known', () => {
    // Being wrong about something free costs nothing, so there is nothing for
    // distrust to protect against.
    const blind = state({ trajectory: { ...state().trajectory, orchestrationConfidence: 0.01 } });
    expect(trust(of({ tokenCost: 0 }), blind).risk).toBe(0);
  });

  it('makes an expensive action riskier as confidence falls', () => {
    const dear = of({ tokenCost: 50_000 });
    const sure = trust(dear, state({ trajectory: { ...state().trajectory, orchestrationConfidence: 0.95 } }));
    const unsure = trust(dear, state({ trajectory: { ...state().trajectory, orchestrationConfidence: 0.1 } }));
    expect(unsure.risk).toBeGreaterThan(sure.risk);
  });

  it('makes the expensive options uncompetitive first as confidence falls', () => {
    // The architectural claim: an orchestrator that knows less does *less*, and
    // what it stops doing is the expensive things.
    const eligible = (orchestrationConfidence: number) => {
      const s = state({ trajectory: { ...state().trajectory, orchestrationConfidence } });
      return [1_000, 20_000, 60_000].filter((tokenCost) => {
        const action = of({ tokenCost, expectedTokenBenefit: tokenCost * 1.5 });
        return trustAdjusted(1, assessDecisionTrust({ state: s, action })) > 0.7;
      }).length;
    };
    expect(eligible(0.95)).toBeGreaterThan(eligible(0.2));
  });

  it('never turns a loss into a gain by distrusting it', () => {
    const distrusted = trust(of({ tokenCost: 90_000 }), state({
      trajectory: { ...state().trajectory, orchestrationConfidence: 0.01 },
    }));
    expect(trustAdjusted(-5, distrusted)).toBeLessThan(0);
    expect(trustAdjusted(-5, distrusted)).toBeGreaterThan(-5);
  });
});

describe('high-consequence decisions demand stronger evidence', () => {
  it('measures what is at stake against what is left, not against the total', () => {
    const early = trust(of({ tokenCost: 1_000 }), state());
    const late = trust(of({ tokenCost: 1_000 }), state({
      resources: { ...state().resources, consumedTokens: 98_800 },
    }));
    expect(late.consequence).toBeGreaterThan(early.consequence);
  });

  it('treats an action that could make the result wrong as consequential however cheap', () => {
    const assessment = trust(of({ tokenCost: 0, qualityRisk: 0.25 }));
    expect(assessment.consequence).toBeCloseTo(0.25);
    expect(assessment.reasonCodes).toContain('consequence:quality');
  });

  it('treats an irreversible action as maximally consequential', () => {
    const assessment = trust(of({ tokenCost: 0, metadata: { irreversible: true } }));
    expect(assessment.consequence).toBe(1);
    expect(assessment.reasonCodes).toContain('consequence:irreversible');
  });

  it('lets the largest consequence govern — a cheap action is not made safe by being cheap', () => {
    const assessment = trust(of({ tokenCost: 1, qualityRisk: 0.8 }));
    expect(assessment.consequence).toBeCloseTo(0.8);
  });

  it('demands the same trust of the same action however it is described', () => {
    expect(trust(of({ tokenCost: 5_000 })).consequence)
      .toBeCloseTo(trust(of({ tokenCost: 2_500, coordinationCost: 2_500 })).consequence);
  });
});

describe('the three confidences fail independently', () => {
  it('separates what the evidence is worth from what the estimate is worth', () => {
    const goodEvidence = state({
      evidence: [{ id: 'e1', kind: 'validation', source: 'test', confidence: 1 }],
    });
    const assessment = trust(of({ confidence: 0.1 }), goodEvidence);
    expect(assessment.evidenceConfidence).toBe(1);
    expect(assessment.mechanismConfidence).toBe(0.1);
    expect(assessment.reasonCodes).toContain('low_mechanism_confidence');
  });

  it('is dragged down hard by one weak term without being pinned to it', () => {
    // A minimum would make one bad number veto everything; a mean would let two
    // good ones hide it.
    const weak = state({
      evidence: [{ id: 'e1', kind: 'observation', source: 's', confidence: 0.1 }],
      trajectory: { ...state().trajectory, orchestrationConfidence: 1 },
    });
    const assessment = trust(of({ tokenCost: 50_000, confidence: 1 }), weak);
    expect(assessment.risk).toBeGreaterThan(0.2);
    expect(assessment.risk).toBeLessThan(0.5);
  });

  it('names which confidence was the weak one, so a receipt says what to fix', () => {
    const lost = state({ trajectory: { ...state().trajectory, orchestrationConfidence: 0.1 } });
    expect(trust(of(), lost).reasonCodes).toContain('low_orchestration_confidence');
  });
});

describe('evidenceConfidenceOf', () => {
  it('treats no evidence as the neutral middle, not as bad evidence', () => {
    // A run that has observed nothing has told us nothing about how reliable
    // its observations are, and scoring that as bad would stop the cheap early
    // interventions most likely to pay.
    expect(evidenceConfidenceOf(state())).toBe(0.5);
  });

  it('weighs something checked above something asserted', () => {
    const checked = state({ evidence: [{ id: 'v', kind: 'validation', source: 's', confidence: 0.8 }] });
    const guessed = state({ evidence: [{ id: 'h', kind: 'hypothesis', source: 's', confidence: 0.8 }] });
    const mixed = state({
      evidence: [
        { id: 'v', kind: 'validation', source: 's', confidence: 0.9 },
        { id: 'h', kind: 'hypothesis', source: 's', confidence: 0.1 },
      ],
    });
    expect(evidenceConfidenceOf(checked)).toBeCloseTo(0.8);
    expect(evidenceConfidenceOf(guessed)).toBeCloseTo(0.8);
    // A pile of guesses must not outvote a test.
    expect(evidenceConfidenceOf(mixed)).toBeGreaterThan(0.5);
  });
});

describe('the engine ranks on trust-adjusted utility', () => {
  const lost = state({ trajectory: { ...state().trajectory, orchestrationConfidence: 0.05 } });

  /** Two options whose raw utility is all but identical — the gamble nets 8,000
   *  tokens and the sure thing 7,900 — so what they are worth is *not* what
   *  decides between them. Trust is. A gamble with a decisively better expected
   *  value should still win under doubt, and does; this is the case where it
   *  should not. */
  const closeCall = () => [
    of({ id: 'cheap', tokenCost: 100, expectedTokenBenefit: 8_000, confidence: 1 }),
    of({ id: 'dear', tokenCost: 70_000, expectedTokenBenefit: 78_000, confidence: 1 }),
  ];

  it('prefers the cheap sure thing to the expensive gamble when it knows little', () => {
    expect(chooseEconomicAction({ state: lost, candidates: closeCall() }).action.id).toBe('cheap');
  });

  it('takes the expensive one when it knows a lot', () => {
    const sure = state({
      evidence: [{ id: 'v', kind: 'validation', source: 'test', confidence: 1 }],
      trajectory: { ...state().trajectory, orchestrationConfidence: 1 },
    });
    expect(chooseEconomicAction({ state: sure, candidates: closeCall() }).action.id).toBe('dear');
  });

  it('does not refuse a gamble whose expected value is decisively better', () => {
    // Trust narrows what is eligible; it does not replace the economics. An
    // orchestrator that refused every expensive option under doubt would be as
    // wrong as one that took every cheap one.
    const decisive = [
      of({ id: 'cheap', tokenCost: 100, expectedTokenBenefit: 8_000, confidence: 1 }),
      of({ id: 'dear', tokenCost: 70_000, expectedTokenBenefit: 90_000, confidence: 1 }),
    ];
    expect(chooseEconomicAction({ state: lost, candidates: decisive }).action.id).toBe('dear');
  });

  it('records why it distrusted what it distrusted', () => {
    const decision = chooseEconomicAction({
      state: lost,
      candidates: [of({ id: 'a', tokenCost: 100, expectedTokenBenefit: 8_000 })],
    });
    expect(decision.reasonCodes).toContain('low_orchestration_confidence');
  });
});
