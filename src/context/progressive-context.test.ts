/** The context ladder, as one story rather than as five modules.
 *
 *  Managed and delegated execution share this path, so it is where an
 *  optimization can quietly make both cheaper *and* both wrong. Three
 *  properties hold the whole thing up:
 *
 *   - the ceiling is a ceiling, never a target — an anchored edit must not fill
 *     it just because it may;
 *   - an expansion buys one artifact and is charged once for it, so the cost of
 *     reaching deeper is always attributable;
 *   - a selector that breaks degrades *upwards*, to the map every dispatch got
 *     before selection existed, never to no context at all. */
import { describe, it, expect, vi } from 'vitest';
import { selectDispatchContext, estimateTokens } from './dispatch-context.js';
import { requestEvidenceAtBoundary, MAX_ARTIFACT_BYTES } from './evidence-actions.js';
import { scopeOf, scopePermits } from './types.js';
import { novelState } from '../architecture/fixtures.js';
import { prepareDispatch } from '../decision/dispatch-preparation.js';
import type { RepoEntry } from '../intelligence/repo-map.js';
import type { Authority } from '../schemas/node-contract.js';

const AUTHORITY: Authority = { tools: ['Read', 'Edit'], spawn_children: false, max_child_count: 0, budget_usd: 5 };

const ENTRIES: RepoEntry[] = [
  { path: 'src/auth/session.ts', bytes: 4_000, symbols: ['refreshSession', 'expireSession'] },
  { path: 'src/auth/session.test.ts', bytes: 3_000, symbols: ['describe'] },
  { path: 'src/auth/store.ts', bytes: 2_500, symbols: ['readToken'] },
  { path: 'src/parser/lexer.ts', bytes: 9_000, symbols: ['tokenize'] },
  { path: 'src/parser/emit.ts', bytes: 7_000, symbols: ['emit'] },
  { path: 'docs/architecture.md', bytes: 12_000, symbols: [] },
  { path: 'README.md', bytes: 1_000, symbols: [] },
];

const CEILING = 6000;

function select(goal: string) {
  return selectDispatchContext({ goal, entries: ENTRIES, tokenBudget: CEILING });
}

describe('narrow before wide', () => {
  it('does not fill the whole context ceiling for an anchored edit', () => {
    const plan = select('Fix refreshSession in src/auth/session.ts');
    expect(plan.receipt.selectedTokens).toBeLessThan(plan.receipt.budget);
  });

  it('reaches the files around a named anchor, not only the anchor', () => {
    const plan = select('Fix refreshSession in src/auth/session.ts');
    expect(plan.receipt.selected).toContain('src/auth/session.ts');
    // The test beside it and the module it reads from are what a lexical match
    // on the goal's words would have missed.
    expect(plan.receipt.selected.length).toBeGreaterThan(1);
  });

  it('gives an unanchored broad goal the repository skeleton rather than nothing', () => {
    // The failure mode a narrowing optimizer walks into: a goal that matches no
    // file structurally selects none, and selecting none is *worse* than the
    // map it replaced. The skeleton is the floor under that.
    const broad = select('Audit every module in the repository for error handling');
    expect(broad.content.length).toBeGreaterThan(0);
    expect(broad.receipt.selectedTokens).toBeLessThanOrEqual(broad.receipt.budget);
  });

  it('gives an anchored task a smaller policy ceiling than a broad one', () => {
    const grant = { allowedTools: AUTHORITY.tools, readOnly: false };
    const anchored = prepareDispatch({ goal: 'Fix refreshSession in src/auth/session.ts', authority: AUTHORITY, toolGrant: grant });
    const broad = prepareDispatch({ goal: 'Audit every module across the entire repository', authority: AUTHORITY, toolGrant: grant });
    expect(anchored.contextPolicy.tokenBudget).toBeLessThan(broad.contextPolicy.tokenBudget);
  });

  it('never exceeds the caller\'s hard ceiling, whatever the policy asks for', () => {
    const plan = selectDispatchContext({ goal: 'Audit everything everywhere', entries: ENTRIES, tokenBudget: 400 });
    expect(plan.receipt.selectedTokens).toBeLessThanOrEqual(400);
  });

  it('still says what it dropped, so an expansion can be priced later', () => {
    const plan = select('Fix refreshSession in src/auth/session.ts');
    expect(plan.receipt.selected.length + plan.receipt.dropped.length).toBeGreaterThan(0);
  });
});

describe('boundary evidence acquisition', () => {
  const state = novelState();
  const request = {
    candidateId: 'src/auth/session.ts',
    evidenceLevel: 'L2' as const,
    expectedBenefit: 6_000,
    acquisitionCost: 1_000,
    qualityRisk: 0.05,
    reasonCodes: ['anchor'],
  };

  it('acquires exactly one artifact per request', async () => {
    const read = vi.fn(() => 'export function refreshSession() {}');
    const result = await requestEvidenceAtBoundary(
      { state, request, worktreePath: '/repo', repositoryRevision: 'rev-1' },
      { sizeOf: () => 40, read },
    );
    expect(result.acquired).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('/repo/src/auth/session.ts');
  });

  it('charges the measured cost, once, from the content it actually read', async () => {
    const content = 'x'.repeat(4_000);
    const result = await requestEvidenceAtBoundary(
      { state, request, worktreePath: '/repo', repositoryRevision: 'rev-1' },
      { sizeOf: () => content.length, read: () => content },
    );
    expect(result.tokens).toBe(estimateTokens(content));
    expect(result.evidence?.tokenCost).toBe(result.tokens);
  });

  it('refuses rather than truncating an artifact it cannot afford to show whole', async () => {
    const result = await requestEvidenceAtBoundary(
      { state, request, worktreePath: '/repo' },
      { sizeOf: () => MAX_ARTIFACT_BYTES + 1, read: () => 'never read' },
    );
    expect(result.acquired).toBe(false);
    expect(result.reasonCodes).toContain('artifact_too_large');
    expect(result.tokens).toBe(0);
  });

  it('refuses an expansion whose cost has stopped being worth its benefit', async () => {
    const result = await requestEvidenceAtBoundary(
      { state, request: { ...request, expectedBenefit: 100, acquisitionCost: 900 }, worktreePath: '/repo' },
      { sizeOf: () => 40, read: () => 'unused' },
    );
    expect(result.acquired).toBe(false);
    expect(result.reasonCodes).toContain('negative_net_value');
  });

  it('stamps the revision, so a later run can tell whether the evidence is stale', async () => {
    const result = await requestEvidenceAtBoundary(
      { state, request, worktreePath: '/repo', repositoryRevision: 'rev-7' },
      { sizeOf: () => 40, read: () => 'contents' },
    );
    expect(result.evidence?.repositoryRevision).toBe('rev-7');
    expect(result.evidence?.id).toContain('rev-7');
  });

  it('never leaves the worktree', async () => {
    const result = await requestEvidenceAtBoundary(
      { state, request: { ...request, candidateId: '../../etc/passwd' }, worktreePath: '/repo' },
      { sizeOf: () => 40, read: () => 'secret' },
    );
    expect(result.acquired).toBe(false);
    expect(result.reasonCodes).toContain('path_outside_worktree');
  });
});

describe('sibling reuse', () => {
  it('only offers evidence a narrower or equal grant produced', () => {
    const narrow = scopeOf(['Read'], true);
    const wide = scopeOf(['Read', 'Grep'], true);
    expect(scopePermits(narrow, wide)).toBe(true);
    expect(scopePermits(wide, narrow)).toBe(false);
  });

  it('refuses reuse across the read-only boundary in either direction', () => {
    // A producer that could write may have reported something it changed, and
    // a read-only consumer asking the same question is not asking for that.
    expect(scopePermits(scopeOf(['Read', 'Edit'], false), scopeOf(['Read'], true))).toBe(false);
    expect(scopePermits(scopeOf(['Read'], true), scopeOf(['Read', 'Edit'], false))).toBe(false);
  });

  it('refuses reuse across tenants', () => {
    const other = { ...scopeOf(['Read'], true), tenant: 'other' };
    expect(scopePermits(other, scopeOf(['Read'], true))).toBe(false);
  });
});

describe('degrading upwards', () => {
  it('a selector that cannot score anything still returns the repository skeleton', () => {
    // Nothing matches, which is the case a narrowing optimizer is most likely
    // to get wrong: selecting nothing is *worse* than the map it replaced.
    const plan = selectDispatchContext({ goal: 'zzzz qqqq', entries: ENTRIES, tokenBudget: CEILING });
    expect(plan.content.length).toBeGreaterThan(0);
  });

  it('returns something usable when there is no repository to look at', () => {
    const plan = selectDispatchContext({ goal: 'Fix the parser', entries: [], tokenBudget: CEILING });
    expect(plan.receipt.selected).toEqual([]);
    expect(plan.estimatedTokens).toBeGreaterThanOrEqual(0);
  });
});
