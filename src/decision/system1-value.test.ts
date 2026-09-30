import { describe, it, expect } from 'vitest';
import { summarizeSystem1Value } from './system1-value.js';

const event = (over: Record<string, unknown>) => ({ type: 'market.system1', payload: { decisionId: 'd', invoked: true, valueUsd: 0.01, expectedCostUsd: 0.002, actualCostUsd: 0.002, decisionChanged: true, avoidable: false, ...over } });

describe('what System-1 was worth', () => {
  it('counts the questions asked, what they cost, and how many changed the decision', () => {
    const s = summarizeSystem1Value([
      event({ decisionChanged: true, actualCostUsd: 0.003 }),
      event({ decisionChanged: false, avoidable: true, actualCostUsd: 0.002 }),
      event({ invoked: false, actualCostUsd: 0, decisionChanged: false, avoidable: false }),
    ]);
    expect(s.decisions).toBe(3);
    expect(s.calls).toBe(2);
    expect(s.costUsd).toBeCloseTo(0.005);
    expect(s.changedDecision).toBe(1);
    expect(s.avoidableCalls).toBe(1);
    expect(s.avoidableRate).toBe(0.5);
    expect(s.callRate).toBeCloseTo(2 / 3);
  });

  it('separates the decisions it declined to ask about, and what it expected them to be worth', () => {
    const s = summarizeSystem1Value([
      event({ invoked: false, valueUsd: 0, actualCostUsd: 0, decisionChanged: false, avoidable: false }),
      event({ invoked: true, valueUsd: 0.02 }),
    ]);
    expect(s.skipped).toBe(1);
    expect(s.expectedValueUsd).toBeCloseTo(0.02);
  });

  it('ignores other events and malformed payloads', () => {
    const s = summarizeSystem1Value([{ type: 'market.decision', payload: {} }, { type: 'market.system1', payload: null }, { type: 'market.system1', payload: 'x' }]);
    expect(s.decisions).toBe(0);
  });

  it('reports zero rates, not NaN, when there was nothing to ask', () => {
    const s = summarizeSystem1Value([]);
    expect(s.callRate).toBe(0);
    expect(s.avoidableRate).toBe(0);
  });
});
