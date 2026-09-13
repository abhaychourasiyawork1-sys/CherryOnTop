/** One synthetic repository, eight kinds of task, end to end.
 *
 *  These are the tests that stop the optimizer from quietly becoming a lookup
 *  table. Every assertion below is about a *property* — this family gets its
 *  anchor and its neighbours, this family does not get the whole tree, an
 *  unclear goal widens rather than prunes — and never about a specific file
 *  being included by name for a specific kind of task. A rule that says
 *  "documentation tasks include README.md" passes on this fixture and is wrong
 *  on the next repository; a rule that says "an anchored file's direct
 *  neighbours come with it" travels.
 *
 *  The pipeline under test is the real one: signals → policy → candidates →
 *  scoring → selection → rendering. */
import { describe, it, expect, afterEach } from 'vitest';
import { selectDispatchContext } from './dispatch-context.js';
import { taskEconomicsFor } from '../efficiency/task-economics.js';
import { contextPolicyFor, executionPolicyFor } from '../efficiency/policy.js';
import { evaluateSpendGuard } from '../efficiency/spend-guard.js';
import type { RepoEntry } from '../intelligence/repo-map.js';

const REPO: RepoEntry[] = [
  { path: 'src/auth/session.ts', symbols: ['refreshSession', 'expireSession'], imports: ['./store.js', '../util/clock.js'] },
  { path: 'src/auth/store.ts', symbols: ['readStore', 'writeStore'], imports: [] },
  { path: 'src/auth/session.test.ts', symbols: [], imports: ['./session.js'] },
  { path: 'src/api/login.ts', symbols: ['login'], imports: ['../auth/session.js'] },
  { path: 'src/api/logout.ts', symbols: ['logout'], imports: ['../auth/session.js'] },
  { path: 'src/billing/invoice.ts', symbols: ['renderInvoice'], imports: ['../util/money.js'] },
  { path: 'src/billing/invoice.test.ts', symbols: [], imports: ['./invoice.js'] },
  { path: 'src/util/clock.ts', symbols: ['now'], imports: [] },
  { path: 'src/util/money.ts', symbols: ['format'], imports: [] },
  { path: 'src/report/render.ts', symbols: ['render'], imports: ['../util/money.js'] },
  { path: 'docs/architecture.md', symbols: [], imports: [] },
  { path: 'README.md', symbols: [], imports: [] },
  { path: 'package.json', symbols: [], imports: [] },
  { path: 'vitest.config.ts', symbols: [], imports: [] },
];

const BUDGET = 6000;

function plan(goal: string) {
  const signals = taskEconomicsFor(goal);
  const context = selectDispatchContext({ goal, entries: REPO, tokenBudget: BUDGET, signals });
  return {
    signals,
    policy: contextPolicyFor(signals),
    execution: executionPolicyFor(signals),
    context,
    selected: context.receipt.selected,
  };
}

/** Every family, and the one property each is really about. */
const FAMILIES = {
  'tiny edit': 'Fix the typo in README.md',
  implementation: 'Add an expiry check to refreshSession in src/auth/session.ts',
  'test authoring': 'Add a unit test for src/billing/invoice.ts renderInvoice',
  debugging: 'Debug why refreshSession in src/auth/session.ts returns a stale token',
  investigation: 'Review the entire codebase and find bugs. Do not modify anything.',
  refactor: 'Refactor src/util/money.ts so every caller shares one formatter',
  documentation: 'Document the session lifecycle in docs/architecture.md',
  'multi-file': 'Rename readStore in src/auth/store.ts and update every caller',
} as const;

afterEach(() => { delete process.env.ORG_REPO_MAP_TOKENS; });

describe('golden task families — every family gets a usable, bounded context', () => {
  for (const [family, goal] of Object.entries(FAMILIES)) {
    it(`${family}: stays under the ceiling and still says something`, () => {
      const { context } = plan(goal);
      expect(context.estimatedTokens).toBeLessThanOrEqual(BUDGET);
      // The repository skeleton is the floor: even a goal that matched nothing
      // leaves the agent knowing the shape of the tree, so selecting can never
      // be worse than the map it replaced.
      expect(context.content).toContain('Repository shape:');
    });

    it(`${family}: leaves the budget mostly unspent rather than filling it`, () => {
      const { context } = plan(goal);
      expect(context.estimatedTokens).toBeLessThan(BUDGET * 0.9);
    });

    it(`${family}: derives a policy that holds its invariants`, () => {
      const { policy, execution } = plan(goal);
      expect(policy.tokenBudget).toBeLessThanOrEqual(BUDGET);
      expect(execution.softTurnTarget).toBeLessThanOrEqual(execution.hardTurnCap);
      expect(execution.hardTurnCap).toBeGreaterThanOrEqual(1);
    });
  }
});

describe('golden task families — the properties, not a file list', () => {
  it('an anchored goal gets its file, its dependency, its dependents and its test', () => {
    const { selected } = plan(FAMILIES.implementation);
    expect(selected).toContain('src/auth/session.ts');      // anchor
    expect(selected).toContain('src/auth/store.ts');        // imports
    expect(selected).toContain('src/api/login.ts');         // imported by
    expect(selected).toContain('src/auth/session.test.ts'); // tests it
  });

  it('and does not get a file with no relationship to it at all', () => {
    const { selected } = plan(FAMILIES.implementation);
    expect(selected).not.toContain('src/report/render.ts');
    expect(selected).not.toContain('src/billing/invoice.ts');
  });

  it('a test-authoring goal reaches the subject under test through the same rule', () => {
    // Not because "test tasks include the tested file" is written down
    // anywhere — because the test and the file share a stem, which is the same
    // relationship an implementation task uses in the other direction.
    const { selected } = plan(FAMILIES['test authoring']);
    expect(selected).toContain('src/billing/invoice.ts');
  });

  it('a refactor across callers reaches the callers', () => {
    const { selected } = plan(FAMILIES.refactor);
    expect(selected).toContain('src/util/money.ts');
    expect(selected.some((p) => p === 'src/billing/invoice.ts' || p === 'src/report/render.ts')).toBe(true);
  });

  it('no family is handed a file by name: drop the edges and the neighbours go', () => {
    // The same goal against a tree with no import edges must lose exactly the
    // neighbours the edges justified. If a file survived that, it was being
    // included by a recipe rather than by evidence.
    const edgeless = REPO.map(({ path, symbols }) => ({ path, symbols, imports: [] }));
    const withEdges = selectDispatchContext({ goal: FAMILIES.implementation, entries: REPO, tokenBudget: BUDGET });
    const without = selectDispatchContext({ goal: FAMILIES.implementation, entries: edgeless, tokenBudget: BUDGET });

    expect(withEdges.receipt.selected).toContain('src/api/login.ts');
    expect(without.receipt.selected).not.toContain('src/api/login.ts');
  });

  it('a read-only investigation is judged to modify nothing and tolerates more searching', () => {
    const investigation = plan(FAMILIES.investigation);
    const edit = plan(FAMILIES['tiny edit']);
    expect(investigation.signals.readOnly).toBe(true);
    expect(investigation.signals.expectedModificationScope).toBe(0);
    expect(investigation.execution.explorationTolerance).toBeGreaterThan(edit.execution.explorationTolerance);
  });

  it('a tiny anchored edit is given less of everything than a broad investigation', () => {
    const tiny = plan(FAMILIES['tiny edit']);
    const broad = plan(FAMILIES.investigation);
    expect(tiny.policy.tokenBudget).toBeLessThan(broad.policy.tokenBudget);
    expect(tiny.execution.hardTurnCap).toBeLessThan(broad.execution.hardTurnCap);
  });
});

describe('golden task families — low confidence widens, never prunes', () => {
  const VAGUE = 'make it better';

  it('an unclear goal is not given a smaller budget than a clear one', () => {
    const vague = plan(VAGUE);
    const clear = plan(FAMILIES.implementation);
    expect(vague.policy.tokenBudget).toBeGreaterThanOrEqual(clear.policy.tokenBudget);
  });

  it('an unclear goal still produces a safe, bounded context rather than nothing', () => {
    const { context } = plan(VAGUE);
    expect(context.content).toContain('Repository shape:');
    expect(context.estimatedTokens).toBeLessThanOrEqual(BUDGET);
  });

  it('an unclear goal is given more turns to find its footing, not fewer', () => {
    expect(plan(VAGUE).execution.hardTurnCap)
      .toBeGreaterThanOrEqual(plan(FAMILIES['tiny edit']).execution.hardTurnCap);
  });
});

describe('golden task families — the economics each family runs under', () => {
  const guardFor = (goal: string, over: Partial<Parameters<typeof evaluateSpendGuard>[0]> = {}) => {
    const { execution } = plan(goal);
    return evaluateSpendGuard({
      spentUsd: 0, spendCapUsd: 10, turns: 0,
      softTurnTarget: execution.softTurnTarget, hardTurnCap: execution.hardTurnCap,
      explorationSignal: 0.3, progressSignal: 0.7, ...over,
    });
  };

  it('lets every family start', () => {
    for (const goal of Object.values(FAMILIES)) expect(guardFor(goal).state).toBe('GREEN');
  });

  it('stops every family at its own turn cap', () => {
    for (const goal of Object.values(FAMILIES)) {
      const { execution } = plan(goal);
      expect(guardFor(goal, { turns: execution.hardTurnCap }).state).toBe('STOP');
    }
  });

  it('stops every family at the spend cap regardless of turns', () => {
    for (const goal of Object.values(FAMILIES)) {
      expect(guardFor(goal, { spentUsd: 10, turns: 1 }).reason).toMatch(/Spend cap/);
    }
  });
});
