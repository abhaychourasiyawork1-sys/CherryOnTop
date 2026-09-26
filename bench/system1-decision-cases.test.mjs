import { describe, it, expect } from 'vitest';
import { WORKLOADS } from './system1-decision-cases.mjs';
import { system1Totals, summarizeEconomicRun, SYSTEM1_FIELDS } from './metrics/economic.mjs';

describe('System-1 benchmark workloads', () => {
  it('covers every workload class the plan requires', () => {
    expect(WORKLOADS.map((w) => w.class).sort()).toEqual([
      'ambiguous implementation choice',
      'coherent global investigation',
      'historical coherent repo-wide investigation',
      'model-initiated decision request',
      'multiple independent workstreams',
      'single-file change',
      'validation failure requiring recovery',
    ]);
    expect(WORKLOADS.find((w) => w.id === 'historical-coherent-review').goal).toBe('Review the codebase and check for bugs, no edits');
  });

  it('keeps ids unique so raw rows join across runs', () => {
    expect(new Set(WORKLOADS.map((w) => w.id)).size).toBe(WORKLOADS.length);
  });
});

describe('System-1 diagnostics in the economic summary', () => {
  it('sums every counter, treating a pre-System-1 record as zero', () => {
    const totals = system1Totals([{ system1Calls: 2, system1LatencyMs: 80, system1Fallbacks: 1 }, { outcome: 'success' }]);
    expect(totals).toMatchObject({ system1Calls: 2, system1LatencyMs: 80, system1Fallbacks: 1, modelDecisionRequests: 0 });
    expect(Object.keys(totals)).toEqual(SYSTEM1_FIELDS);
  });

  it('is attributed beside the whole-harness metrics, never inside them', () => {
    const summary = summarizeEconomicRun([{ outcome: 'success', totalTokens: 1000, system1InputTokens: 300, system1Calls: 1 }]);
    expect(summary.tokensPerSuccessfulTask).toBe(1000);
    expect(summary.system1).toMatchObject({ system1InputTokens: 300, system1Calls: 1 });
  });
});
