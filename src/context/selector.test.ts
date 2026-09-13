import { describe, it, expect } from 'vitest';
import { selectContext } from './selector.js';
import { createContextScorer } from './scoring.js';
import { buildCandidates, tokensAt, type ContextCandidate } from './candidates.js';
import { contextPolicyFor } from '../efficiency/policy.js';
import { taskEconomicsFor } from '../efficiency/task-economics.js';
import type { ContextPolicy } from '../efficiency/policy-types.js';
import type { RepoEntry } from '../intelligence/repo-map.js';

const scorer = createContextScorer();
const policy = (over: Partial<ContextPolicy> = {}): ContextPolicy =>
  ({ tokenBudget: 1000, optimizationBudget: 100, confidenceFloor: 0.35, ...over });

const candidate = (over: Partial<ContextCandidate> = {}): ContextCandidate => ({
  key: 'src/a.ts', path: 'src/a.ts', symbols: [], evidenceLevel: 'L1', estimatedTokens: 10,
  lexicalScore: 2, structuralScore: 0, taskFitScore: 0.5, confidenceScore: 0.5,
  reuseScore: 0, relationships: [], materialization: 'inventory', ...over,
});

const select = (candidates: ContextCandidate[], p: ContextPolicy = policy()) =>
  selectContext({ candidates, policy: p, scorer });

describe('selectContext — the budget is a ceiling', () => {
  it('stops early when nothing left is worth its room, well under budget', () => {
    const result = select([
      candidate({ path: 'src/good.ts', structuralScore: 1, confidenceScore: 0.7, relationships: ['imports:src/x.ts'] }),
      candidate({ path: 'src/junk.ts', lexicalScore: 0.2, confidenceScore: 0.02, taskFitScore: 0, estimatedTokens: 400, symbols: Array.from({ length: 90 }, (_, i) => `sym${i}`) }),
    ], policy({ tokenBudget: 5000, confidenceFloor: 0 }));
    expect(result.estimatedTokens).toBeLessThan(500);
    expect(result.selected.map((c) => c.path)).toContain('src/good.ts');
  });

  it('never exceeds the budget', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      candidate({ path: `src/f${i}.ts`, key: `src/f${i}.ts`, structuralScore: 1, confidenceScore: 0.7, relationships: [`imports:src/x${i}.ts`] }));
    const result = select(many, policy({ tokenBudget: 300 }));
    expect(result.estimatedTokens).toBeLessThanOrEqual(300);
    expect(result.truncated).toBe(true);
  });

  it('selects nothing at a zero budget and keeps every candidate as dropped', () => {
    const result = select([candidate()], policy({ tokenBudget: 0 }));
    expect(result.selected).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.estimatedTokens).toBe(0);
  });

  it('does not report truncation when it simply ran out of things worth taking', () => {
    const result = select([candidate({ structuralScore: 1, confidenceScore: 0.7, relationships: ['imports:x'] })], policy({ tokenBudget: 5000 }));
    expect(result.truncated).toBe(false);
  });
});

describe('selectContext — progressive evidence', () => {
  const rich = candidate({
    path: 'src/auth/session.ts',
    symbols: Array.from({ length: 30 }, (_, i) => `symbol${i}`),
    relationships: ['imports:src/auth/store.ts', 'tested-by:src/auth/session.test.ts'],
    evidenceLevel: 'L2', structuralScore: 1, confidenceScore: 1, lexicalScore: 4,
  });

  it('hands over the richest level when the room is there', () => {
    expect(select([rich], policy({ tokenBudget: 5000 })).selected[0].selectedLevel).toBe('L2');
  });

  it('demotes rather than drops when the room is not', () => {
    const tight = select([rich], policy({ tokenBudget: tokensAt(rich, 'L0') + 1 }));
    expect(tight.selected).toHaveLength(1);
    expect(tight.selected[0].selectedLevel).toBe('L0');
    // The path still got through — four tokens that save a search.
    expect(tight.selected[0].selectedTokens).toBeLessThanOrEqual(tokensAt(rich, 'L0'));
  });

  it('charges what it actually handed over, not what the candidate offered', () => {
    const tight = select([rich], policy({ tokenBudget: tokensAt(rich, 'L1') }));
    const chosen = tight.selected[0];
    expect(chosen.selectedTokens).toBe(tokensAt(chosen, chosen.selectedLevel));
    expect(tight.estimatedTokens).toBe(chosen.selectedTokens);
  });

  it('refuses an escalation whose increment does not pay for itself', () => {
    const bloated = candidate({
      path: 'src/bloat.ts', evidenceLevel: 'L2', lexicalScore: 0.4, confidenceScore: 0.3,
      symbols: Array.from({ length: 200 }, (_, i) => `sym${i}`), relationships: ['imports:src/x.ts'],
      structuralScore: 0.1,
    });
    const chosen = select([bloated], policy({ tokenBudget: 100000, confidenceFloor: 0 })).selected[0];
    expect(chosen.selectedLevel).toBe('L0');
  });
});

describe('selectContext — marginal stopping', () => {
  it('skips a candidate whose expected saving is below its incremental cost', () => {
    const weak = candidate({ path: 'src/weak.ts', lexicalScore: 0.1, confidenceScore: 0.01, taskFitScore: 0, structuralScore: 0, symbols: Array.from({ length: 120 }, (_, i) => `s${i}`) });
    const result = select([weak], policy({ tokenBudget: 5000, confidenceFloor: 0 }));
    expect(result.selected).toHaveLength(0);
    expect(result.dropped.map((c) => c.path)).toContain('src/weak.ts');
    // Refused for value, not for room.
    expect(result.truncated).toBe(false);
  });
});

describe('selectContext — low confidence widens', () => {
  it('takes weak candidates it would otherwise refuse when nothing is confident', () => {
    const weak = candidate({ path: 'src/weak.ts', lexicalScore: 0.1, confidenceScore: 0.05, taskFitScore: 0, symbols: Array.from({ length: 120 }, (_, i) => `s${i}`) });
    const pruned = select([weak], policy({ tokenBudget: 5000, confidenceFloor: 0 }));
    const widened = select([weak], policy({ tokenBudget: 5000, confidenceFloor: 0.9 }));
    expect(pruned.selected).toHaveLength(0);
    expect(widened.selected).toHaveLength(1);
  });

  it('still respects the ceiling while widened', () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      candidate({ path: `src/w${i}.ts`, key: `src/w${i}.ts`, confidenceScore: 0.05, lexicalScore: 0.1 }));
    const widened = select(many, policy({ tokenBudget: 200, confidenceFloor: 0.9 }));
    expect(widened.estimatedTokens).toBeLessThanOrEqual(200);
  });
});

describe('selectContext — end to end over a real inventory', () => {
  const ENTRIES: RepoEntry[] = [
    { path: 'src/auth/session.ts', symbols: ['refreshSession'], imports: ['./store.js'] },
    { path: 'src/auth/store.ts', symbols: ['readStore'], imports: [] },
    { path: 'src/auth/session.test.ts', symbols: [], imports: ['./session.js'] },
    { path: 'src/billing/invoice.ts', symbols: ['renderInvoice'], imports: [] },
  ];

  const run = (goal: string) => {
    const signals = taskEconomicsFor(goal);
    return selectContext({
      candidates: buildCandidates({
        entries: ENTRIES, goal,
        anchors: goal.includes('session.ts') ? ['session.ts'] : [],
        taskFit: signals,
      }),
      policy: contextPolicyFor(signals),
      scorer,
    });
  };

  it('gives an anchored goal its file, its dependency and its test — and not the unrelated one', () => {
    const paths = run('Fix the refresh bug in src/auth/session.ts').selected.map((c) => c.path);
    expect(paths).toContain('src/auth/session.ts');
    expect(paths).toContain('src/auth/store.ts');
    expect(paths).toContain('src/auth/session.test.ts');
    expect(paths).not.toContain('src/billing/invoice.ts');
  });

  it('reports a confidence it can stand behind', () => {
    const result = run('Fix the refresh bug in src/auth/session.ts');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('is deterministic for one goal against one tree', () => {
    expect(run('Fix the refresh bug in src/auth/session.ts'))
      .toEqual(run('Fix the refresh bug in src/auth/session.ts'));
  });
});
