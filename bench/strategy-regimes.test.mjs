import { describe, it, expect } from 'vitest';
import {
  STRATEGY_REGIMES, REGIME_COLUMNS, capabilitiesOf, reachabilityOf,
  manifest, learnableRows, exercisedIn,
} from './strategy-regimes.mjs';

const ALL = {
  spawn_children: true, multiple_children: true, child_budget: true, context_planner: true,
};

describe('the manifest', () => {
  it('declares every regime\'s reachability conditions before anything runs', () => {
    for (const regime of STRATEGY_REGIMES) {
      expect(Array.isArray(regime.requires)).toBe(true);
      expect(regime.expectation.length).toBeGreaterThan(0);
      expect(regime.strategy).toBeTruthy();
    }
  });

  it('covers all three strategies', () => {
    const strategies = new Set(STRATEGY_REGIMES.map((regime) => regime.strategy));
    expect(strategies).toEqual(new Set(['MANAGED', 'SERIAL_DELEGATED', 'PARALLEL_DELEGATED']));
  });

  it('names every column a regime row has to report', () => {
    expect(REGIME_COLUMNS).toEqual(expect.arrayContaining([
      'success', 'cost', 'turns', 'wallSeconds', 'validationLevel', 'recoveryCount', 'strategy',
    ]));
  });

  it('uses unique regime ids', () => {
    expect(new Set(STRATEGY_REGIMES.map((r) => r.id)).size).toBe(STRATEGY_REGIMES.length);
  });
});

describe('reachability', () => {
  it('reports a regime with delegation disabled as UNREACHABLE, not as a failed task', () => {
    // "The configuration forbade this" and "the product could not do this" are
    // different claims, and only one of them is a regression.
    const verdict = reachabilityOf(
      STRATEGY_REGIMES.find((r) => r.id === 'PARALLEL_DELEGATED'),
      { ...ALL, spawn_children: false },
    );
    expect(verdict.reachability).toBe('UNREACHABLE');
    expect(verdict.missing).toContain('spawn_children');
  });

  it('never reports a regime as FAILED for a configuration reason', () => {
    for (const regime of STRATEGY_REGIMES) {
      const verdict = reachabilityOf(regime, {
        spawn_children: false, multiple_children: false, child_budget: false, context_planner: false,
      });
      expect(['REACHABLE', 'UNREACHABLE']).toContain(verdict.reachability);
    }
  });

  it('keeps managed regimes reachable under every configuration', () => {
    for (const regime of STRATEGY_REGIMES.filter((r) => r.requires.length === 0)) {
      expect(reachabilityOf(regime, {}).reachability).toBe('REACHABLE');
    }
  });

  it('reads the configuration the daemon will actually run under', () => {
    expect(capabilitiesOf({ ORG_MAX_CHILD_JOBS: '0' }).spawn_children).toBe(false);
    expect(capabilitiesOf({ ORG_MAX_CHILD_JOBS: '1' }).multiple_children).toBe(false);
    expect(capabilitiesOf({ ORG_REPO_MAP_TOKENS: '0' }).context_planner).toBe(false);
    expect(capabilitiesOf({}).spawn_children).toBe(true);
  });

  it('builds a full manifest with a verdict per regime', () => {
    const rows = manifest({ ORG_MAX_CHILD_JOBS: '1' });
    expect(rows).toHaveLength(STRATEGY_REGIMES.length);
    expect(rows.find((r) => r.id === 'PARALLEL_DELEGATED').reachability).toBe('UNREACHABLE');
    expect(rows.find((r) => r.id === 'MANAGED_SIMPLE').reachability).toBe('REACHABLE');
  });
});

describe('what may become learning evidence', () => {
  const rows = [
    { regime: 'MANAGED_SIMPLE', reachability: 'REACHABLE', validity: 'VALID' },
    { regime: 'MANAGED_MEDIUM', reachability: 'REACHABLE', validity: 'INVALID_INFRA' },
    { regime: 'MANAGED_RISKY', reachability: 'REACHABLE', validity: 'INVALID_TELEMETRY' },
    { regime: 'PARALLEL_DELEGATED', reachability: 'UNREACHABLE', validity: 'VALID' },
  ];

  it('excludes invalid infrastructure, environment, telemetry and snapshot rows', () => {
    const { usable, excluded } = learnableRows(rows);
    expect(usable).toHaveLength(1);
    expect(excluded.INVALID_INFRA).toBe(1);
    expect(excluded.INVALID_TELEMETRY).toBe(1);
  });

  it('excludes an unreachable regime, because there was no run to learn from', () => {
    expect(learnableRows(rows).excluded.UNREACHABLE).toBe(1);
  });

  it('counts what it set aside rather than dropping it silently', () => {
    const { total, usable, excluded } = learnableRows(rows);
    expect(total).toBe(4);
    expect(usable.length + Object.values(excluded).reduce((a, b) => a + b, 0)).toBe(total);
  });
});

describe('exercised is not reachable', () => {
  it('reports a reachable regime nothing chose as unexercised', () => {
    const parallel = STRATEGY_REGIMES.find((r) => r.id === 'PARALLEL_DELEGATED');
    expect(reachabilityOf(parallel, ALL).reachability).toBe('REACHABLE');
    expect(exercisedIn(parallel, [{ regime: 'MANAGED_SIMPLE', strategy: 'MANAGED' }])).toBe(false);
  });

  it('reports a regime a run actually took as exercised', () => {
    const managed = STRATEGY_REGIMES.find((r) => r.id === 'MANAGED_SIMPLE');
    expect(exercisedIn(managed, [{ regime: 'MANAGED_SIMPLE', strategy: 'MANAGED' }])).toBe(true);
  });
});
