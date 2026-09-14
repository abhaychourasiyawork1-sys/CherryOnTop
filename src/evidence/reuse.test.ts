import { describe, it, expect } from 'vitest';
import { evaluateHistoricalEvidence, RETRIEVAL_TOKEN_COST } from './reuse.js';
import type { KnowledgeItem } from './types.js';
import { initialEconomicState, normalizeEconomicState, type EconomicState } from '../decision/state.js';

const REPO = 'github.com/acme/app';

const item = (over: Partial<KnowledgeItem> = {}): KnowledgeItem => ({
  id: 'k1',
  kind: 'fact',
  content: 'refreshSession reads the session store before the cookie, and returns null on a miss.',
  repository: REPO,
  revision: 'rev-1',
  sourcePaths: ['src/auth/session.ts'],
  sourceSymbols: ['refreshSession'],
  confidence: 0.9,
  validated: true,
  createdAt: '2026-09-14T00:00:00.000Z',
  ...over,
});

function state(over: Partial<EconomicState> = {}): EconomicState {
  const base = initialEconomicState({
    goal: 'g', totalTokenBudget: 100_000, repository: REPO, repositoryRevision: 'rev-1',
  });
  return normalizeEconomicState({ ...base, ...over });
}

describe('same revision, already checked', () => {
  it('is reusable directly', () => {
    const result = evaluateHistoricalEvidence({ item: item(), state: state() });
    expect(result.usable).toBe(true);
    expect(result.directReuse).toBe(true);
    expect(result.requiresVerification).toBe(false);
    expect(result.staleRisk).toBe(0);
    expect(result.verificationCost).toBe(0);
    expect(result.reasonCodes).toEqual(expect.arrayContaining(['same_revision', 'validated', 'direct_reuse']));
  });

  it('still charges for getting it out of the store', () => {
    // Retrieval that claims to be free is retrieval nobody can hold to account,
    // and this is the number that makes memory net value measurable.
    expect(evaluateHistoricalEvidence({ item: item(), state: state() }).retrievalCost)
      .toBe(RETRIEVAL_TOKEN_COST);
  });

  it('does not reuse an unchecked claim directly, even at the same revision', () => {
    const result = evaluateHistoricalEvidence({ item: item({ validated: false }), state: state() });
    expect(result.directReuse).toBe(false);
    expect(result.reasonCodes).not.toContain('direct_reuse');
  });
});

describe('a revision mismatch is a cost, not a disqualification', () => {
  const moved = () => state({ repositoryRevision: 'rev-2' });

  it('makes a fact usable only after checking it', () => {
    const result = evaluateHistoricalEvidence({ item: item(), state: moved() });
    expect(result.directReuse).toBe(false);
    expect(result.staleRisk).toBeGreaterThan(0);
    expect(result.verificationCost).toBeGreaterThan(0);
    expect(result.reasonCodes).toContain('revision_mismatch');
  });

  it('rots a fact faster than a pattern', () => {
    // A fact about a revision is about *that* revision. A pattern — where tests
    // live, how modules are named — usually outlives a hundred revisions, which
    // is why kind is a column rather than a confidence number.
    const fact = evaluateHistoricalEvidence({ item: item({ kind: 'fact' }), state: moved() });
    const pattern = evaluateHistoricalEvidence({ item: item({ kind: 'pattern' }), state: moved() });
    const observation = evaluateHistoricalEvidence({ item: item({ kind: 'observation' }), state: moved() });
    expect(pattern.staleRisk).toBeLessThan(observation.staleRisk);
    expect(observation.staleRisk).toBeLessThan(fact.staleRisk);
  });

  it('rots an unchecked claim faster than a checked one', () => {
    const checked = evaluateHistoricalEvidence({ item: item({ validated: true }), state: moved() });
    const asserted = evaluateHistoricalEvidence({ item: item({ validated: false }), state: moved() });
    expect(asserted.staleRisk).toBeGreaterThan(checked.staleRisk);
  });

  it('refuses when checking it costs more than going and looking', () => {
    // A tiny claim: verifying it is nearly as expensive as deriving it, and
    // deriving it is cheap.
    const trivial = item({ kind: 'fact', content: 'x', confidence: 0.2, validated: false });
    const result = evaluateHistoricalEvidence({ item: trivial, state: moved() });
    expect(result.usable).toBe(false);
    expect(result.reasonCodes).toContain('rediscovery_is_cheaper');
  });

  it('accepts a large claim worth verifying', () => {
    const substantial = item({ content: 'x'.repeat(4_000) });
    const result = evaluateHistoricalEvidence({ item: substantial, state: moved() });
    expect(result.usable).toBe(true);
    expect(result.requiresVerification).toBe(true);
  });
});

describe('current evidence outranks historical knowledge', () => {
  const observed = (subject: string) => state({
    evidence: [{ id: `observed:${subject}`, kind: 'fact', source: `run:${subject}`, confidence: 0.9 }],
  });

  it('refuses a stored claim about a file this run has already read', () => {
    const result = evaluateHistoricalEvidence({ item: item(), state: observed('src/auth/session.ts') });
    expect(result.usable).toBe(false);
    expect(result.reasonCodes).toContain('current_evidence_outranks_history');
  });

  it('refuses on a symbol match too', () => {
    expect(evaluateHistoricalEvidence({ item: item(), state: observed('refreshSession') }).usable).toBe(false);
  });

  it('is a rule, not a weighting a large benefit could overturn', () => {
    const enormous = item({ content: 'x'.repeat(100_000) });
    const result = evaluateHistoricalEvidence({ item: enormous, state: observed('src/auth/session.ts') });
    expect(result.usable).toBe(false);
    expect(result.expectedBenefit).toBe(0);
  });

  it('still offers a claim about a part of the repository this run has not seen', () => {
    const elsewhere = item({ sourcePaths: ['src/billing/invoice.ts'], sourceSymbols: ['renderInvoice'] });
    expect(evaluateHistoricalEvidence({ item: elsewhere, state: observed('src/auth/session.ts') }).usable).toBe(true);
  });
});

describe('refusals that are not about staleness', () => {
  it('refuses a withdrawn item', () => {
    const result = evaluateHistoricalEvidence({
      item: item({ invalidatedAt: '2026-09-15T00:00:00.000Z' }), state: state(),
    });
    expect(result.usable).toBe(false);
    expect(result.reasonCodes).toContain('withdrawn');
  });

  it('refuses a claim about a different repository, which is irrelevant rather than stale', () => {
    const result = evaluateHistoricalEvidence({
      item: item({ repository: 'github.com/other/app' }), state: state(),
    });
    expect(result.usable).toBe(false);
    expect(result.reasonCodes).toContain('different_repository');
  });

  it('treats a run with no known revision as a mismatch rather than a match', () => {
    const unknown = normalizeEconomicState({ ...state(), repositoryRevision: undefined });
    expect(evaluateHistoricalEvidence({ item: item(), state: unknown }).directReuse).toBe(false);
  });
});

describe('totality', () => {
  it('is deterministic', () => {
    const input = { item: item(), state: state() };
    expect(evaluateHistoricalEvidence(input)).toEqual(evaluateHistoricalEvidence(input));
  });

  it('keeps every reported quantity finite and in range', () => {
    for (const candidate of [item(), item({ confidence: 0, validated: false }), item({ content: '' })]) {
      const result = evaluateHistoricalEvidence({ item: candidate, state: state({ repositoryRevision: 'rev-9' }) });
      expect(Number.isFinite(result.expectedBenefit)).toBe(true);
      expect(result.staleRisk).toBeGreaterThanOrEqual(0);
      expect(result.staleRisk).toBeLessThanOrEqual(1);
    }
  });
});
