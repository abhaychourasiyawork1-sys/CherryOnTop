import { describe, it, expect } from 'vitest';
import {
  evaluateInformationOpportunity, DEFAULT_DISCOVERY_MODEL, type DiscoveryModel,
} from './information-economics.js';
import type { ContextCandidate } from '../context/candidates.js';
import { initialEconomicState, normalizeEconomicState, type EconomicState } from '../decision/state.js';

function state(over: Partial<EconomicState> = {}): EconomicState {
  const base = initialEconomicState({ goal: 'g', totalTokenBudget: 100_000 });
  return normalizeEconomicState({
    ...base,
    uncertainty: { target: 0.5, structural: 0.5, behavioral: 0.5, validation: 0.5 },
    trajectory: { ...base.trajectory, orchestrationConfidence: 1 },
    resources: { ...base.resources, latencyBudgetMs: 600_000 },
    ...over,
  });
}

const candidate = (over: Partial<ContextCandidate> = {}): ContextCandidate => ({
  key: 'src/a.ts', path: 'src/a.ts', symbols: ['a'], evidenceLevel: 'L1',
  estimatedTokens: 20, lexicalScore: 0, structuralScore: 0, taskFitScore: 0.5,
  confidenceScore: 0.7, reuseScore: 0, relationships: [], materialization: 'inventory',
  ...over,
});

/** A file the goal named outright. The agent opens it first whatever we do. */
const anchor = () => candidate({ relationships: ['anchor'], structuralScore: 1, confidenceScore: 1 });

/** A neighbour the compiler ties to an anchored file. The expensive case: the
 *  agent has to *discover* it. */
const neighbour = () => candidate({
  path: 'src/b.ts', relationships: ['imported-by:src/a.ts'], structuralScore: 1, confidenceScore: 0.7,
});

/** The test that covers a file being changed. */
const coveringTest = () => candidate({
  path: 'src/a.test.ts', relationships: ['test-of:src/a.ts'], structuralScore: 1, confidenceScore: 0.7,
});

describe('provide now versus discover later', () => {
  it('prices a structural neighbour above what it costs to hand over', () => {
    const e = evaluateInformationOpportunity({ candidate: neighbour(), state: state() });
    expect(e.expectedRediscoveryCost).toBeGreaterThan(e.acquisitionCost);
    expect(e.expectedNetValue).toBeGreaterThan(0);
  });

  it('prices a file the goal already named as barely worth rediscovering', () => {
    const named = evaluateInformationOpportunity({ candidate: anchor(), state: state() });
    const found = evaluateInformationOpportunity({ candidate: neighbour(), state: state() });
    // The agent was going to open the anchor first anyway, so nothing is saved
    // by handing it over — that is the whole asymmetry the selector exploits.
    expect(named.expectedRediscoveryCost).toBeLessThan(found.expectedRediscoveryCost);
  });

  it('turns negative for a candidate nothing ties to the goal', () => {
    const unrelated = candidate({
      path: 'src/unrelated.ts', relationships: [], structuralScore: 0, confidenceScore: 0,
      estimatedTokens: 400,
    });
    const e = evaluateInformationOpportunity({ candidate: unrelated, state: state() });
    expect(e.expectedRediscoveryCost).toBe(0);
    expect(e.expectedNetValue).toBeLessThan(0);
  });

  it('charges a bigger candidate more to acquire', () => {
    const cheap = evaluateInformationOpportunity({ candidate: neighbour(), state: state() });
    const dear = evaluateInformationOpportunity({
      candidate: { ...neighbour(), estimatedTokens: 5_000 }, state: state(),
    });
    expect(dear.acquisitionCost).toBeGreaterThan(cheap.acquisitionCost);
    expect(dear.expectedNetValue).toBeLessThan(cheap.expectedNetValue);
  });

  it('scales rediscovery with how expensive searching actually is', () => {
    const cheapSearch: DiscoveryModel = { ...DEFAULT_DISCOVERY_MODEL, tokensPerExploratoryTurn: 100 };
    const dearSearch: DiscoveryModel = { ...DEFAULT_DISCOVERY_MODEL, tokensPerExploratoryTurn: 20_000 };
    const cheap = evaluateInformationOpportunity({ candidate: neighbour(), state: state(), model: cheapSearch });
    const dear = evaluateInformationOpportunity({ candidate: neighbour(), state: state(), model: dearSearch });
    expect(dear.expectedRediscoveryCost).toBeGreaterThan(cheap.expectedRediscoveryCost);
  });
});

describe('quality-risk reduction is real value, not a tiebreak', () => {
  it('can beat a token-only candidate on net value', () => {
    // A candidate with a modest token saving and meaningful quality-risk
    // reduction against one with a larger token saving and none.
    const highValidationDoubt = state({
      uncertainty: { target: 0.2, structural: 0.2, behavioral: 0.9, validation: 0.9 },
    });
    const test = evaluateInformationOpportunity({ candidate: coveringTest(), state: highValidationDoubt });
    const plain = evaluateInformationOpportunity({ candidate: neighbour(), state: highValidationDoubt });

    expect(test.expectedQualityRiskReduction).toBeGreaterThan(plain.expectedQualityRiskReduction);
    expect(test.expectedNetValue).toBeGreaterThan(plain.expectedNetValue);
  });

  it('scales with the doubt the artifact actually speaks to', () => {
    const certain = state({ uncertainty: { target: 0, structural: 0, behavioral: 0, validation: 0 } });
    const doubtful = state({ uncertainty: { target: 1, structural: 1, behavioral: 1, validation: 1 } });
    expect(evaluateInformationOpportunity({ candidate: coveringTest(), state: certain }).expectedQualityRiskReduction).toBe(0);
    expect(evaluateInformationOpportunity({ candidate: coveringTest(), state: doubtful }).expectedQualityRiskReduction).toBeGreaterThan(0);
  });

  it('prices a unit of quality at a budget of tokens, as 2:2:1 says it should', () => {
    const s = state();
    const e = evaluateInformationOpportunity({ candidate: coveringTest(), state: s });
    // Net value minus the token terms must be the quality term, and the
    // exchange rate must be the objective's own: tokens and quality weigh the
    // same, so one unit of quality is one whole budget.
    const latencyInTokens = (e.expectedLatencyReduction / 600_000) * 0.5 * 100_000;
    const qualityInTokens = e.expectedNetValue - e.expectedRediscoveryCost - latencyInTokens + e.acquisitionCost;
    expect(qualityInTokens).toBeCloseTo(e.expectedQualityRiskReduction * 100_000, 4);
  });

  it('is never negative — evidence does not make a result more likely to be wrong', () => {
    for (const c of [anchor(), neighbour(), coveringTest(), candidate()]) {
      expect(evaluateInformationOpportunity({ candidate: c, state: state() }).expectedQualityRiskReduction)
        .toBeGreaterThanOrEqual(0);
    }
  });
});

describe('the optimizer charges itself', () => {
  it('includes evaluation overhead in the acquisition cost', () => {
    const e = evaluateInformationOpportunity({ candidate: neighbour(), state: state() });
    expect(e.acquisitionCost).toBe(neighbour().estimatedTokens + DEFAULT_DISCOVERY_MODEL.evaluationCost);
  });

  it('lets a large enough overhead make a marginal candidate not worth evaluating', () => {
    const marginal = candidate({ relationships: [], structuralScore: 0, confidenceScore: 0, estimatedTokens: 4 });
    const free = evaluateInformationOpportunity({
      candidate: marginal, state: state(), model: { ...DEFAULT_DISCOVERY_MODEL, evaluationCost: 0 },
    });
    const expensive = evaluateInformationOpportunity({
      candidate: marginal, state: state(), model: { ...DEFAULT_DISCOVERY_MODEL, evaluationCost: 500 },
    });
    expect(expensive.expectedNetValue).toBeLessThan(free.expectedNetValue);
    expect(expensive.expectedNetValue).toBeLessThan(0);
  });

  it('never reports a negative acquisition cost', () => {
    const e = evaluateInformationOpportunity({
      candidate: candidate({ estimatedTokens: -100 }), state: state(),
      model: { ...DEFAULT_DISCOVERY_MODEL, evaluationCost: -5 },
    });
    expect(e.acquisitionCost).toBe(0);
  });
});

describe('confidence and totality', () => {
  it('caps confidence by how much the orchestrator trusts its own reading', () => {
    const doubtful = state({ trajectory: { ...state().trajectory, orchestrationConfidence: 0.2 } });
    expect(evaluateInformationOpportunity({ candidate: neighbour(), state: doubtful }).confidence)
      .toBeLessThanOrEqual(0.2);
  });

  it('does not divide by a zero budget', () => {
    const broke = normalizeEconomicState({ ...state(), resources: { ...state().resources, totalTokenBudget: 0 } });
    const e = evaluateInformationOpportunity({ candidate: neighbour(), state: broke });
    expect(Number.isFinite(e.expectedNetValue)).toBe(true);
  });

  it('does not divide by a missing latency budget', () => {
    const noLatency = normalizeEconomicState({
      ...state(), resources: { ...state().resources, latencyBudgetMs: undefined },
    });
    expect(Number.isFinite(evaluateInformationOpportunity({ candidate: neighbour(), state: noLatency }).expectedNetValue)).toBe(true);
  });

  it('is deterministic', () => {
    const c = neighbour();
    const s = state();
    expect(evaluateInformationOpportunity({ candidate: c, state: s }))
      .toEqual(evaluateInformationOpportunity({ candidate: c, state: s }));
  });
});
