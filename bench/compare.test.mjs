import { describe, it, expect } from 'vitest';
import { dispatchFlags, dispatchConfig,
  pairRuns, pairKeyOf, pairedDifference, signTestP, describeEvidence,
  isolationFor, isolationConflict, classifyFailure, runMetadata, validateMetadata,
  environmentFingerprintOf, modelsOf,
  MAX_ENVIRONMENT_RETRIES,
} from './compare.mjs';

const row = (over = {}) => ({
  goal: 'typo-fix',
  repositoryRevision: 'abc123',
  provider: 'anthropic',
  models: 'execute:sonnet plan:haiku',
  environmentFingerprint: 'node22/kind',
  tokensPerSuccess: 100_000,
  ...over,
});

describe('pairing refuses the comparisons that only look like results', () => {
  it('pairs two runs of the same goal under the same conditions', () => {
    const { pairs, reasons } = pairRuns([row()], [row({ tokensPerSuccess: 80_000 })]);
    expect(pairs).toHaveLength(1);
    expect(reasons).toEqual([]);
  });

  it('refuses to pair across repository revisions', () => {
    const { pairs, reasons } = pairRuns([row()], [row({ repositoryRevision: 'def456' })]);
    expect(pairs).toEqual([]);
    expect(reasons).toContain('unmatched:full:typo-fix');
    expect(reasons).toContain('unmatched:baseline:typo-fix');
  });

  it('refuses to pair across models or providers', () => {
    expect(pairRuns([row()], [row({ models: 'execute:opus' })]).pairs).toEqual([]);
    expect(pairRuns([row()], [row({ provider: 'openai' })]).pairs).toEqual([]);
  });

  it('refuses to pair across environments', () => {
    expect(pairRuns([row()], [row({ environmentFingerprint: 'node20/k3s' })]).pairs).toEqual([]);
  });

  it('returns what it could not pair rather than discarding it', () => {
    // A comparison over five of seven goals is a different claim from one over
    // seven, and silently dropping the two makes them the same claim.
    const { pairs, unmatchedBaseline, unmatchedFull } = pairRuns(
      [row({ goal: 'a' }), row({ goal: 'b' })],
      [row({ goal: 'a' }), row({ goal: 'c' })],
    );
    expect(pairs.map((p) => p.goal)).toEqual(['a']);
    expect(unmatchedBaseline.map((r) => r.goal)).toEqual(['b']);
    expect(unmatchedFull.map((r) => r.goal)).toEqual(['c']);
  });

  it('pairs repeats of one goal one-to-one rather than fanning them out', () => {
    const { pairs } = pairRuns(
      [row({ tokensPerSuccess: 1 }), row({ tokensPerSuccess: 2 })],
      [row({ tokensPerSuccess: 3 }), row({ tokensPerSuccess: 4 })],
    );
    expect(pairs).toHaveLength(2);
  });

  it('is deterministic whatever order the rows arrive in', () => {
    const baseline = [row({ goal: 'b' }), row({ goal: 'a' })];
    const full = [row({ goal: 'a' }), row({ goal: 'b' })];
    expect(pairRuns(baseline, full).pairs.map((p) => p.goal))
      .toEqual(pairRuns([...baseline].reverse(), [...full].reverse()).pairs.map((p) => p.goal));
  });

  it('treats a missing field as its own value rather than as a wildcard', () => {
    expect(pairKeyOf({ goal: 'x' })).toContain('unknown-revision');
    expect(pairRuns([{ goal: 'x' }], [row({ goal: 'x' })]).pairs).toEqual([]);
  });
});

describe('the paired difference, and how little it is worth', () => {
  const pairs = (baselines, fulls) => pairRuns(
    baselines.map((v, i) => row({ goal: `g${i}`, tokensPerSuccess: v })),
    fulls.map((v, i) => row({ goal: `g${i}`, tokensPerSuccess: v })),
  ).pairs;

  it('reports the mean and median difference and which way each pair went', () => {
    const result = pairedDifference(pairs([100, 100, 100], [80, 90, 120]), 'tokensPerSuccess');
    expect(result.n).toBe(3);
    expect(result.meanDifference).toBeCloseTo((-20 - 10 + 20) / 3);
    expect(result.medianDifference).toBe(-10);
    expect(result.wins).toBe(2);
    expect(result.losses).toBe(1);
  });

  it('averages the per-pair percentages, so one huge goal does not decide the headline', () => {
    const result = pairedDifference(
      pairRuns(
        [row({ goal: 'small', tokensPerSuccess: 100 }), row({ goal: 'huge', tokensPerSuccess: 1_000_000 })],
        [row({ goal: 'small', tokensPerSuccess: 50 }), row({ goal: 'huge', tokensPerSuccess: 990_000 })],
      ).pairs,
      'tokensPerSuccess',
    );
    // -50% and -1%, so -25.5 — not the -1.0% a ratio of the totals would give.
    expect(result.meanPercent).toBeCloseTo(-25.5, 1);
  });

  it('honours a metric where higher is better', () => {
    const result = pairedDifference(pairs([0.5, 0.5], [0.9, 0.9]), 'tokensPerSuccess', { lowerIsBetter: false });
    expect(result.wins).toBe(2);
    expect(result.losses).toBe(0);
  });

  it('refuses to say anything beyond direction from too few pairs', () => {
    const result = pairedDifference(pairs([100, 100], [50, 50]), 'tokensPerSuccess');
    expect(result.evidence).toContain('too few paired observations');
  });

  it('never calls anything significant, however consistent', () => {
    const consistent = pairs(Array(12).fill(100), Array(12).fill(50));
    const result = pairedDifference(consistent, 'tokensPerSuccess');
    // A harness that produces a confident p-value from a dozen paired
    // observations is a harness that will be quoted.
    expect(result.evidence).toContain('suggestive, not conclusive');
    expect(result.evidence).not.toContain('significant');
  });

  it('says plainly when there is no consistent direction', () => {
    const mixed = pairs([100, 100, 100, 100, 100, 100], [90, 110, 90, 110, 90, 110]);
    expect(pairedDifference(mixed, 'tokensPerSuccess').evidence).toContain('no consistent direction');
  });

  it('reports nothing rather than zero when a metric is missing', () => {
    const result = pairedDifference(pairs([100], [100]).map((p) => ({ ...p, full: { goal: 'g0' } })), 'tokensPerSuccess');
    expect(result.n).toBe(0);
    expect(result.meanDifference).toBeNull();
    expect(result.evidence).toBe('no paired observations');
  });

  it('handles no pairs at all', () => {
    expect(pairedDifference([], 'tokensPerSuccess').n).toBe(0);
    expect(() => pairedDifference(undefined, 'tokensPerSuccess')).not.toThrow();
  });
});

describe('signTestP', () => {
  it('is exact rather than approximated', () => {
    // Five wins and no losses under a fair coin: 2 * (1/32).
    expect(signTestP(5, 0)).toBeCloseTo(0.0625, 6);
    expect(signTestP(1, 1)).toBeCloseTo(1, 6);
  });

  it('is symmetric', () => {
    expect(signTestP(7, 2)).toBeCloseTo(signTestP(2, 7), 12);
  });

  it('never exceeds one', () => {
    expect(signTestP(3, 3)).toBeLessThanOrEqual(1);
    expect(signTestP(0, 0)).toBeNull();
  });

  it('describes a coarse result coarsely', () => {
    expect(describeEvidence(0, null)).toBe('no paired observations');
    expect(describeEvidence(3, 0.25)).toContain('too few');
  });
});

describe('the arms cannot read each other', () => {
  it('gives each arm its own port and database', () => {
    const baseline = isolationFor('baseline');
    const full = isolationFor('full');
    // Two arms sharing a SQLite file is not a subtle contamination: the second
    // reads the first's efficiency records and reports them as its own.
    expect(isolationConflict(baseline, full)).toBe(false);
    expect(baseline.databasePath).not.toBe(full.databasePath);
  });

  it('assigns the same resources on a rerun', () => {
    // A comparison you cannot repeat is not a measurement.
    expect(isolationFor('full')).toEqual(isolationFor('full'));
  });

  it('does not depend on the order the arms were named in', () => {
    const a = isolationFor('baseline');
    const b = isolationFor('full');
    expect(isolationFor('full').port).toBe(b.port);
    expect(isolationFor('baseline').port).toBe(a.port);
  });

  it('exposes the environment a run needs to honour the isolation', () => {
    const isolation = isolationFor('full');
    expect(isolation.env.ORG_DAEMON_PORT).toBe(String(isolation.port));
    expect(isolation.env.ORG_DB_PATH).toBe(isolation.databasePath);
  });

  it('detects a conflict when one is configured', () => {
    expect(isolationConflict({ port: 1, databasePath: 'a' }, { port: 1, databasePath: 'b' })).toBe(true);
    expect(isolationConflict({ port: 1, databasePath: 'a' }, { port: 2, databasePath: 'a' })).toBe(true);
  });
});

describe('an environment failure is not a product failure', () => {
  it('retries a rate limit, an expired credential, a network blip, a broken cluster', () => {
    for (const text of [
      'Error: 429 rate limit exceeded',
      'Claude credentials are unusable — please run `claude login`',
      'connect ECONNREFUSED 127.0.0.1:6443',
      'Failed to pull image: ErrImagePull',
      'ENOSPC: no space left on device',
    ]) {
      expect(classifyFailure(text).retryable, text).toBe(true);
      expect(classifyFailure(text).scope, text).toBe('environment');
    }
  });

  it('records a product failure as a result rather than retrying it', () => {
    // Retrying a real failure turns a finding into a flake.
    const verdict = classifyFailure('The agent reported: could not find the off-by-one error');
    expect(verdict.retryable).toBe(false);
    expect(verdict.scope).toBe('product');
  });

  it('names which environment problem it saw, so a run can be diagnosed', () => {
    expect(classifyFailure('429 too many requests').kind).toBe('rate_limited');
    expect(classifyFailure('401 unauthorized').kind).toBe('credentials');
  });

  it('treats an empty or missing message as a product failure', () => {
    // Silence is not evidence of an environment problem, and assuming it is
    // would retry every unexplained failure until the matrix ran out.
    expect(classifyFailure('').retryable).toBe(false);
    expect(classifyFailure(undefined).retryable).toBe(false);
  });

  it('bounds retries, so a persistently broken environment stops the run', () => {
    expect(MAX_ENVIRONMENT_RETRIES).toBeGreaterThan(0);
    expect(MAX_ENVIRONMENT_RETRIES).toBeLessThanOrEqual(3);
  });
});

describe('metadata is what makes a result repeatable', () => {
  const metadata = (over = {}) => runMetadata({
    startedAt: '2026-09-14T00:00:00.000Z',
    mode: 'efficiency',
    goalSet: 'goals',
    goalIds: ['typo-fix', 'add-test'],
    repositoryRevision: 'abc123',
    repositoryDirty: false,
    nodeVersion: 'v22.22.2',
    provider: 'anthropic',
    models: 'execute:sonnet',
    runnerImage: 'cherryontop-runner:local',
    policyVersions: ['full:ctx-1/exec-1:dec-1', 'baseline:ctx-1/exec-1:dec-1'],
    arms: [isolationFor('baseline'), isolationFor('full')],
    ...over,
  });

  it('accepts a run that can be reproduced', () => {
    expect(validateMetadata(metadata()).reproducible).toBe(true);
  });

  it('refuses a run with no revision to reproduce against', () => {
    expect(validateMetadata(metadata({ repositoryRevision: null })).problems)
      .toContain('no repository revision recorded');
  });

  it('refuses a run made against a dirty tree', () => {
    // The revision does not describe what ran.
    expect(validateMetadata(metadata({ repositoryDirty: true })).reproducible).toBe(false);
  });

  it('refuses a run spanning two policy generations', () => {
    const spanning = metadata({
      policyVersions: ['full:ctx-1/exec-1:dec-1', 'full:ctx-2/exec-1:dec-1'],
    });
    expect(validateMetadata(spanning).problems.some((p) => p.includes('policy generations'))).toBe(true);
  });

  it('refuses arms that share a port or a database', () => {
    const colliding = metadata({
      arms: [
        { arm: 'a', port: 7801, databasePath: '.bench/a/org.db' },
        { arm: 'b', port: 7801, databasePath: '.bench/b/org.db' },
      ],
    });
    expect(validateMetadata(colliding).problems.some((p) => p.includes('share a port'))).toBe(true);
  });

  it('sorts what it records, so two runs of one experiment produce one file', () => {
    expect(metadata().goalIds).toEqual(['add-test', 'typo-fix']);
    expect(metadata().policyVersions[0]).toContain('baseline');
  });
});

describe('dispatch flags', () => {
  it('reaches delegation only when both the children and the budget allow it', () => {
    // The defect this exists to stop: `org run` defaults --max-children to 0,
    // so a benchmark that sets nothing measures a runtime with delegation,
    // the spend guard and the execution veto all switched off — and reports
    // it as though it had exercised them.
    expect(dispatchFlags({})).toEqual([]);
    expect(dispatchConfig({}).delegationReachable).toBe(false);
    expect(dispatchConfig({ ORG_BENCH_MAX_CHILDREN: '3' }).delegationReachable).toBe(false);
    expect(dispatchConfig({ ORG_BENCH_MAX_CHILDREN: '3', ORG_BENCH_BUDGET_USD: '0.5' }).delegationReachable).toBe(false);
    expect(dispatchConfig({ ORG_BENCH_MAX_CHILDREN: '3', ORG_BENCH_BUDGET_USD: '5' }).delegationReachable).toBe(true);
  });

  it('builds the flags every arm is dispatched with', () => {
    expect(dispatchFlags({ ORG_BENCH_MAX_CHILDREN: '3', ORG_BENCH_BUDGET_USD: '5' }))
      .toEqual(['--spawn', '--max-children', '3', '--budget', '5']);
  });

  it('reports the spend guard as disengaged unless a cap is set', () => {
    // The hard-budget regime's cap was never set in the 2026-09-17 run, so the
    // guard was never engaged and the regime tested nothing.
    expect(dispatchConfig({}).spendGuardEngaged).toBe(false);
    expect(dispatchConfig({ ORG_TASK_SPEND_CAP_USD: '4' }).spendGuardEngaged).toBe(true);
  });
});

describe('environmentFingerprintOf', () => {
  it('is the same shape run.mjs and regime-runner.mjs both need to pair a row', () => {
    // 2026-09-20: regime-runner.mjs never computed this at all, so every row
    // it wrote failed pairKeyOf's match against run.mjs's rows and reported
    // as "unmatched" even when the same goal, revision and environment ran in
    // both. One function, imported by both scripts, so they cannot drift
    // apart again.
    const fp = environmentFingerprintOf({ ORG_K8S_NAMESPACE: 'ns', ORG_RUNNER_IMAGE: 'img:tag' });
    expect(fp).toBe(`${process.version}/ns/img:tag`);
  });

  it('defaults the namespace and runner image the same way the daemon does', () => {
    expect(environmentFingerprintOf({})).toBe(`${process.version}/org-exec/cherryontop-runner:local`);
  });
});

describe('modelsOf', () => {
  it('renders one role:model token per row, the same format run.mjs writes', () => {
    expect(modelsOf({ rows: [{ role: 'execute', model: 'sonnet' }, { role: 'plan', model: 'haiku' }] }))
      .toBe('execute:sonnet plan:haiku');
  });

  it('is empty for a node with no dispatches', () => {
    expect(modelsOf({ rows: [] })).toBe('');
  });
});
