import { describe, it, expect, afterEach } from 'vitest';
import {
  generateExecutionCandidates, executionEstimate, executionPrior, candidateIdFor, PRIOR_CONFIDENCE, EXECUTION_CAPABILITY,
} from './model-router.js';
import { fitCapability, type CapabilityObservation } from './capability.js';
import { markFeasibility } from './provider-router.js';
import { chooseEconomicAction } from '../decision/engine.js';
import { initialEconomicState, normalizeEconomicState } from '../decision/state.js';
import type { ActionCandidate } from '../decision/actions.js';
import type { HarnessCapabilitySnapshot } from '../adapters/adapter.js';

afterEach(() => {
  for (const key of ['ORG_MODEL_FAST', 'ORG_MODEL_STANDARD', 'ORG_MODEL_DEEP', 'ORG_MODEL_EXECUTE', 'ORG_MODEL_PLAN']) {
    delete process.env[key];
  }
});

const harness = (name: string, over: Partial<HarnessCapabilitySnapshot> = {}): HarnessCapabilitySnapshot => ({
  harness: name, acceptsModelFlag: true, serves: () => true, efforts: ['default'], models: [],
  supportsSession: false, health: 'healthy', fingerprint: `fp-${name}`, ...over,
});

const claude = harness('claude-code', {
  serves: (m) => /haiku|sonnet|opus|fable/.test(m),
  models: ['haiku', 'sonnet', 'opus', 'fable'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
});
const codex = harness('codex', { serves: (m) => !/haiku|sonnet|opus|fable|claude/.test(m) });

const unknown = fitCapability([]);

function candidates(
  difficulty: number,
  harnesses = [claude],
  role: 'plan' | 'execute' | 'synthesize' = 'execute',
  extra: { capability?: ReturnType<typeof fitCapability>; difficultyUpper?: number } = {},
) {
  return generateExecutionCandidates({
    role, difficulty, harnesses, dispatchTokens: 40_000, dispatchLatencyMs: 120_000,
    ...(extra.capability ? { capability: extra.capability } : {}),
    ...(extra.difficultyUpper !== undefined ? { difficultyUpper: extra.difficultyUpper } : {}),
  });
}

const state = () => initialEconomicState({ goal: 'g', totalTokenBudget: 4_000_000 });

/** What the market picks, with every estimate from the router's own priors —
 *  the production pairing before any history exists. */
function choose(cands: ActionCandidate[], s = state()) {
  const executable = markFeasibility({ candidates: cands, harnesses: [claude, codex] });
  const estimates = Object.fromEntries(executable.map((c) => [c.id, executionEstimate(c, s)]));
  return chooseEconomicAction({ state: s, candidates: executable, estimates });
}

const passes = (model: string, difficulty: number, n: number, validated = true): CapabilityObservation[] =>
  Array.from({ length: n }, () => ({
    modelKey: `execute|claude-code|${model}`, candidateKey: `execute|claude-code|${model}|high`,
    facts: {}, difficulty, validated, weight: 1,
  }));

describe('execution candidates are atomic Harness × Model × Effort', () => {
  it('proposes every model and effort each harness offers, each with its own identity', () => {
    const cands = candidates(0.5, [claude, codex]);
    const ids = cands.map((c) => c.id);
    for (const model of ['haiku', 'sonnet', 'opus', 'fable']) {
      for (const effort of ['low', 'max']) expect(ids).toContain(candidateIdFor('claude-code', model, effort));
    }
    expect(ids).toContain(candidateIdFor('codex', undefined, 'default'));
    expect(new Set(cands.map((c) => c.metadata.fingerprint)).size).toBe(cands.length);
    expect(cands.every((c) => c.capability === EXECUTION_CAPABILITY)).toBe(true);
  });

  it('adds a model an operator configured, and never drops the harness default', () => {
    process.env.ORG_MODEL_DEEP = 'claude-opus-5-5';
    const models = new Set(candidates(0.5).map((c) => c.metadata.model));
    expect(models.has('claude-opus-5-5')).toBe(true);
    expect(models.has(undefined)).toBe(true);
  });

  it('narrows the set to an explicitly named model rather than bypassing the market', () => {
    process.env.ORG_MODEL_EXECUTE = 'sonnet';
    const cands = candidates(0.5, [claude, codex]);
    expect(new Set(cands.map((c) => c.metadata.model))).toEqual(new Set(['sonnet']));
    expect(cands.every((c) => c.metadata.constraint === 'operator_model')).toBe(true);
    const decision = choose(cands);
    expect(decision.action.metadata.harness).toBe('claude-code');
    expect(decision.reasonCodes.some((c) => c.includes('harness_cannot_serve_model'))).toBe(true);
  });
});

describe('nothing is ranked before there is evidence', () => {
  it('gives every candidate the same capability belief, whatever its name, price or position', () => {
    const means = new Set(candidates(0.5).map((c) => (c.metadata.capabilityMean as number).toFixed(6)));
    expect(means.size).toBe(1);
  });

  it('carries the adapter-reported facts and the identity used to learn', () => {
    const custom = harness('h', { models: ['m1'], efforts: ['e1'], candidateFacts: () => ({ ctx: 8 }) });
    const c = candidates(0.5, [custom]).find((x) => x.metadata.model === 'm1')!;
    expect(c.metadata.facts).toMatchObject({ ctx: 8 });
    expect(typeof (c.metadata.facts as Record<string, number>).logUsdPerToken).toBe('number');
    expect(c.metadata.candidateKey).toBe('execute|h|m1|e1');
  });

  it('prices every effort of a model the same until something is measured', () => {
    const sonnet = candidates(0.5).filter((c) => c.metadata.model === 'sonnet');
    expect(new Set(sonnet.map((c) => c.tokenCost)).size).toBe(1);
  });
});

describe('model and effort follow the task’s difficulty through learned capability', () => {
  // Haiku is seen passing easy work and failing hard work; opus is seen passing hard work.
  const learned = fitCapability([
    ...passes('haiku', 0.1, 12), ...passes('haiku', 0.8, 12, false), ...passes('opus', 0.8, 12),
  ]);
  const pick = (difficulty: number) => choose(candidates(
    difficulty, [claude], 'execute', { capability: learned, difficultyUpper: Math.min(1, difficulty + 0.05) },
  )).action;

  it('picks a cheap candidate for easy work and one that has shown it can do hard work as it gets harder', () => {
    expect(pick(0.1).metadata.model).toBe('haiku');
    expect(pick(0.8).metadata.model).toBe('opus');
  });

  it('keeps the delivered-correct probability at or above the floor, so it does not gamble on quality', () => {
    for (const d of [0.2, 0.5, 0.8]) {
      const decision = choose(candidates(d));
      expect(decision.successLowerBound).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('prices a shortfall as retries and wrong answers, not as a rule', () => {
    const weakOnHard = executionPrior({ difficulty: 0.9, capability: 0.1 });
    const strongOnHard = executionPrior({ difficulty: 0.9, capability: 1 });
    expect(weakOnHard.success).toBeLessThan(strongOnHard.success);
    expect(weakOnHard.qualityRisk).toBeGreaterThan(strongOnHard.qualityRisk);
  });

  it('replaces the token guess with what the ledger measured for that model', () => {
    const measured = generateExecutionCandidates({
      role: 'execute', difficulty: 0.2, harnesses: [claude], dispatchTokens: 40_000, dispatchLatencyMs: 1,
      measuredTokens: { haiku: 240_000 },
    });
    const haiku = measured.find((c) => c.id === candidateIdFor('claude-code', 'haiku', 'medium'))!;
    const sonnet = measured.find((c) => c.id === candidateIdFor('claude-code', 'sonnet', 'medium'))!;
    // Measured: six times the tokens. The cheap model is now priced as what it
    // actually cost here — and the market moves off it without a rule.
    expect(haiku.tokenCost).toBeGreaterThan(sonnet.tokenCost * 4);
    expect(choose(measured).action.metadata.model).not.toBe('haiku');
  });
});

describe('a wrong result costs more the worse it can be detected', () => {
  it('prices undetected error above detected error', () => {
    const c = candidates(0.9)[0];
    const at = (qualityFloor: number) => normalizeEconomicState({ ...state(), constraints: { ...state().constraints, qualityFloor } });
    const strict = executionEstimate(c, at(0.9));
    const lax = executionEstimate(c, at(0.3));
    expect(lax.expectedRemainingCost.usd).toBeGreaterThan(strict.expectedRemainingCost.usd);
  });
});

describe('doubt widens the pessimistic bounds', () => {
  it('a candidate with more evidence has a tighter cost upper bound', () => {
    const pickSonnet = (n: number) => candidates(0.5, [claude], 'execute', {
      capability: fitCapability(passes('sonnet', 0.5, n)), difficultyUpper: 0.6,
    }).find((c) => c.id === candidateIdFor('claude-code', 'sonnet', 'high'))!;
    const few = executionEstimate(pickSonnet(1), state());
    const many = executionEstimate(pickSonnet(30), state());
    expect(many.bounds.costUpperBoundUsd - many.immediateCost.usd)
      .toBeLessThan(few.bounds.costUpperBoundUsd - few.immediateCost.usd);
  });

  it('a higher upper difficulty widens the bound', () => {
    const at = (upper: number) => candidates(0.5, [claude], 'execute', { difficultyUpper: upper })[0];
    expect(executionEstimate(at(0.95), state()).bounds.costUpperBoundUsd)
      .toBeGreaterThan(executionEstimate(at(0.5), state()).bounds.costUpperBoundUsd);
  });
});

describe('estimates', () => {
  it('starts at low confidence, and lets history take over as it accumulates', () => {
    const [c] = candidates(0.5);
    expect(executionEstimate(c, state()).confidence).toBe(PRIOR_CONFIDENCE);
    expect(executionEstimate(c, state()).provenance).toBe('hybrid');
    const learned = executionEstimate(c, state(), {
      success: 0.99, qualityRisk: 0, tokens: 1_000, costUsd: 0.001, latencyMs: 1, effectiveObservations: 40,
    });
    expect(learned.provenance).toBe('empirical');
    expect(learned.confidence).toBeGreaterThan(0.8);
    expect(learned.immediateCost.usd).toBeLessThan(executionEstimate(c, state()).immediateCost.usd);
  });

  it('prices a candidate that keeps coming in over estimate higher next time', () => {
    const [c] = candidates(0.5);
    const evidence = { success: 0.8, qualityRisk: 0.05, tokens: 40_000, costUsd: 0.2, latencyMs: 1, effectiveObservations: 20 };
    const unbiased = executionEstimate(c, state(), evidence);
    const underPriced = executionEstimate(c, state(), { ...evidence, costBiasUsd: 0.1 });
    expect(underPriced.immediateCost.usd).toBeGreaterThan(unbiased.immediateCost.usd);
  });

  it('prices a budget-capped run as cheaper but less likely to finish', () => {
    const c = candidates(0.5).find((x) => x.metadata.model === 'sonnet' && x.metadata.effort === 'medium')!;
    const full = executionEstimate(c, state());
    const capped = executionEstimate({
      ...c, tokenCost: Math.floor(c.tokenCost / 2), metadata: { ...c.metadata, budgetShare: 0.5, budgetCapUsd: 0.01 },
    }, state());
    expect(capped.immediateCost.usd).toBeLessThanOrEqual(0.01);
    expect(capped.outcomes[0].probability).toBeLessThan(full.outcomes[0].probability);
  });

  it('refuses an uncapped candidate that exceeds the budget — capping is the runtime’s job', () => {
    const tight = normalizeEconomicState({ ...state(), resources: { ...state().resources, budgetUsd: 1, spentUsd: 0.99 } });
    // Uncapped, everything costs more than the cent that is left. The runtime
    // path caps them first (execution-market.test.ts) so it never blocks.
    const decision = choose(candidates(0.5), tight);
    expect(decision.reasonCodes.some((c) => c.endsWith('insufficient_budget_usd'))).toBe(true);
  });
});
