import { describe, it, expect } from 'vitest';
import { DecisionSchema } from './decision.js';

describe('DecisionSchema', () => {
  it('accepts a delegation decision with a full score breakdown', () => {
    const result = DecisionSchema.safeParse({
      id: 'd1', nodeId: 'n1', type: 'execution_decision',
      outcome: 'DELEGATE',
      breakdown: { estimatedValue: 1, modelCost: 0.1, latencyCost: 0.05, coordinationCost: 0.15, verificationCost: 0.1, riskPenalty: 0, threshold: 0.3, score: 0.6 },
      createdAt: '2026-09-05T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown outcome', () => {
    const result = DecisionSchema.safeParse({
      id: 'd1', nodeId: 'n1', type: 'execution_decision', outcome: 'MAYBE',
      breakdown: {}, createdAt: '2026-09-05T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a runtime selection scored the same way', () => {
    const result = DecisionSchema.safeParse({
      id: 'd2', nodeId: 'n1', type: 'runtime_selection', outcome: 'codex',
      breakdown: { successRate: 0.86, costPenalty: 0, latencyPenalty: 0, score: 0.86 },
      createdAt: '2026-09-05T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a runtime selection with no runtime named', () => {
    const result = DecisionSchema.safeParse({
      id: 'd2', nodeId: 'n1', type: 'runtime_selection', outcome: '',
      breakdown: {}, createdAt: '2026-09-05T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown decision type', () => {
    const result = DecisionSchema.safeParse({
      id: 'd3', nodeId: 'n1', type: 'vibes', outcome: 'DELEGATE',
      breakdown: {}, createdAt: '2026-09-05T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});
