import { describe, it, expect } from 'vitest';
import { markFeasibility } from './provider-router.js';
import { generateExecutionCandidates, executionEstimate } from './model-router.js';
import { chooseEconomicAction } from '../decision/engine.js';
import { initialEconomicState } from '../decision/state.js';
import type { HarnessCapabilitySnapshot } from '../adapters/adapter.js';

const harness = (name: string, over: Partial<HarnessCapabilitySnapshot> = {}): HarnessCapabilitySnapshot => ({
  harness: name, acceptsModelFlag: true, serves: () => true, efforts: ['default'], models: ['haiku'],
  supportsSession: false, health: 'healthy', fingerprint: `fp-${name}`, ...over,
});

const generate = (harnesses: HarnessCapabilitySnapshot[]) => generateExecutionCandidates({
  role: 'execute', difficulty: 0.3, harnesses, dispatchTokens: 40_000, dispatchLatencyMs: 120_000,
});

const reasons = (harnesses: HarnessCapabilitySnapshot[], refused?: Map<string, string>) =>
  markFeasibility({ candidates: generate(harnesses), harnesses, refused })
    .map((c) => [c.id, c.metadata.infeasible ?? null] as const);

describe('feasibility, not choice', () => {
  it('rules out a harness that is down or rate limited, and says why', () => {
    const marked = reasons([harness('a', { health: 'down' }), harness('b', { health: 'rate_limited' })]);
    expect(marked.every(([, why]) => why === 'harness_down' || why === 'harness_rate_limited')).toBe(true);
  });

  it('rules out a model the harness cannot serve, before anything is priced', () => {
    const marked = reasons([harness('codex', { serves: (m) => !/haiku/.test(m) })]);
    expect(marked.find(([id]) => id.includes('haiku'))?.[1]).toBe('harness_cannot_serve_model');
    expect(marked.find(([id]) => id.includes(':default:'))?.[1]).toBeNull();
  });

  it('rules out a named model on a harness with no model flag at all', () => {
    const marked = reasons([harness('stopgap', { acceptsModelFlag: false })]);
    expect(marked.find(([id]) => id.includes('haiku'))?.[1]).toBe('harness_has_no_model_flag');
    expect(marked.find(([id]) => id.includes(':default:'))?.[1]).toBeNull();
  });

  it('carries a refusal observed earlier in the run', () => {
    const id = 'exec:a:haiku:default';
    const marked = reasons([harness('a')], new Map([[id, 'model_unavailable_on_plan']]));
    expect(marked.find(([cid]) => cid === id)?.[1]).toBe('model_unavailable_on_plan');
  });

  it('prices a degraded harness as riskier rather than ruling it out', () => {
    const [healthy] = markFeasibility({ candidates: generate([harness('a')]), harnesses: [harness('a')] });
    const [degraded] = markFeasibility({ candidates: generate([harness('a', { health: 'degraded' })]), harnesses: [harness('a', { health: 'degraded' })] });
    expect(degraded.metadata.infeasible).toBeUndefined();
    expect(degraded.failureRisk).toBeGreaterThan(healthy.failureRisk);
  });
});

describe('an outage changes feasibility, never the architecture', () => {
  it('the same market answers, from what is still runnable', () => {
    const state = initialEconomicState({ goal: 'g', totalTokenBudget: 2_000_000 });
    const decideOn = (harnesses: HarnessCapabilitySnapshot[]) => {
      const cands = markFeasibility({ candidates: generate(harnesses), harnesses });
      return chooseEconomicAction({
        state, candidates: cands,
        estimates: Object.fromEntries(cands.map((c) => [c.id, executionEstimate(c, state)])),
      });
    };
    const up = decideOn([harness('claude-code'), harness('codex')]);
    const down = decideOn([harness('claude-code', { health: 'down' }), harness('codex')]);
    expect(up.blocked).toBe(false);
    expect(down.blocked).toBe(false);
    expect(down.action.metadata.harness).toBe('codex');
    expect(down.reasonCodes.some((c) => c.includes('unavailable:harness_down'))).toBe(true);
  });

  it('blocks, and says so, when nothing at all can run', () => {
    const state = initialEconomicState({ goal: 'g', totalTokenBudget: 2_000_000 });
    const harnesses = [harness('only', { health: 'down' })];
    const decision = chooseEconomicAction({ state, candidates: markFeasibility({ candidates: generate(harnesses), harnesses }) });
    expect(decision.blocked).toBe(true);
    expect(decision.reasonCodes).toContain('blocked:no_feasible_action');
  });
});
