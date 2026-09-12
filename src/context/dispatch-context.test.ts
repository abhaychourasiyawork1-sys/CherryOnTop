import { describe, it, expect } from 'vitest';
import { selectDispatchContext, estimateTokens } from './dispatch-context.js';
import type { RepoEntry } from '../intelligence/repo-map.js';

const entry = (path: string, symbols: string[] = []): RepoEntry => ({ path, symbols });

const REPO: RepoEntry[] = [
  entry('src/auth/session.ts', ['refreshSession', 'expireSession', 'SessionToken']),
  entry('src/auth/login.ts', ['login', 'logout']),
  entry('src/cart/discount.ts', ['applyDiscount', 'DiscountRule']),
  entry('src/cart/checkout.ts', ['checkout']),
  entry('src/render/canvas.ts', ['paint', 'clear']),
  entry('docs/architecture.md'),
];

describe('selectDispatchContext', () => {
  it('ranks the file the goal names above unrelated ones', () => {
    const context = selectDispatchContext({ goal: 'fix session refresh', entries: REPO, tokenBudget: 2000 });
    const selected = context.receipt.selected;
    expect(selected[0]).toBe('src/auth/session.ts');
    expect(selected).not.toContain('src/render/canvas.ts');
  });

  it('matches on symbol names, not just paths', () => {
    const context = selectDispatchContext({ goal: 'applyDiscount returns the wrong total', entries: REPO, tokenBudget: 2000 });
    expect(context.receipt.selected).toContain('src/cart/discount.ts');
  });

  it('splits camelCase symbols so a plain-English goal still matches', () => {
    const context = selectDispatchContext({ goal: 'the refresh token expires too early', entries: REPO, tokenBudget: 2000 });
    expect(context.receipt.selected).toContain('src/auth/session.ts');
  });

  it('leaves the budget unspent when little is relevant', () => {
    // The whole point: the budget is a ceiling, not a target. Filling it with
    // the highest-scoring leftovers is how a 6000-token map ended up on every
    // dispatch regardless of what the dispatch was for.
    const context = selectDispatchContext({ goal: 'fix session refresh', entries: REPO, tokenBudget: 4000 });
    expect(context.estimatedTokens).toBeLessThanOrEqual(4000);
    expect(context.estimatedTokens).toBeLessThan(4000);
    expect(context.receipt.dropped.length).toBeGreaterThan(0);
  });

  it('never exceeds the budget, however many candidates there are', () => {
    const many = Array.from({ length: 5000 }, (_, i) => entry(`src/session/part-${i}.ts`, ['refreshSession']));
    const context = selectDispatchContext({ goal: 'fix session refresh', entries: many, tokenBudget: 800 });
    expect(context.estimatedTokens).toBeLessThanOrEqual(800);
    expect(estimateTokens(context.content)).toBeLessThanOrEqual(800);
  });

  it('says so when relevant material did not fit', () => {
    const many = Array.from({ length: 500 }, (_, i) => entry(`src/session/part-${i}.ts`, ['refreshSession']));
    const context = selectDispatchContext({ goal: 'fix session refresh', entries: many, tokenBudget: 300 });
    expect(context.receipt.truncated).toBe(true);
  });

  it('always shows the shape of the repository, even when nothing scores', () => {
    // A goal whose words appear nowhere must still leave the agent knowing
    // which directories exist — otherwise selection is strictly worse than the
    // full map it replaces.
    const context = selectDispatchContext({ goal: 'xyzzy plugh', entries: REPO, tokenBudget: 2000 });
    expect(context.content).toContain('src/auth');
    expect(context.content).toContain('src/cart');
    expect(context.receipt.selected).toEqual([]);
  });

  it('records what it dropped and why the receipt adds up', () => {
    const context = selectDispatchContext({ goal: 'fix session refresh', entries: REPO, tokenBudget: 2000 });
    const accounted = new Set([...context.receipt.selected, ...context.receipt.dropped]);
    expect(accounted.size).toBe(REPO.length);
    expect(context.receipt.budget).toBe(2000);
    expect(context.receipt.selectedTokens).toBe(context.estimatedTokens);
  });

  it('deduplicates repeated paths', () => {
    const context = selectDispatchContext({
      goal: 'fix session refresh',
      entries: [entry('src/auth/session.ts', ['refreshSession']), entry('src/auth/session.ts', ['refreshSession'])],
      tokenBudget: 2000,
    });
    expect(context.receipt.selected).toEqual(['src/auth/session.ts']);
  });

  it('produces nothing at all for a zero budget', () => {
    const context = selectDispatchContext({ goal: 'fix session refresh', entries: REPO, tokenBudget: 0 });
    expect(context.content).toBe('');
    expect(context.estimatedTokens).toBe(0);
  });

  it('survives an empty repository and an empty goal', () => {
    expect(selectDispatchContext({ goal: '', entries: REPO, tokenBudget: 2000 }).content).toBeTypeOf('string');
    expect(selectDispatchContext({ goal: 'anything', entries: [], tokenBudget: 2000 }).content).toBe('');
  });

  it('ignores stopwords, so common English does not select the whole repo', () => {
    const context = selectDispatchContext({ goal: 'the and for with this that from', entries: REPO, tokenBudget: 4000 });
    expect(context.receipt.selected).toEqual([]);
  });

  it('is deterministic — the same goal and repo select the same context', () => {
    const a = selectDispatchContext({ goal: 'fix session refresh', entries: REPO, tokenBudget: 2000 });
    const b = selectDispatchContext({ goal: 'fix session refresh', entries: REPO, tokenBudget: 2000 });
    expect(a.content).toBe(b.content);
  });
});
