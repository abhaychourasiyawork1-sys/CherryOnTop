import { describe, it, expect } from 'vitest';
import { classifyValidity, telemetryAnomaly, partitionByValidity, renderValidity } from './validity.mjs';

const REV = 'a'.repeat(40);
const ok = (over = {}) => ({
  goal: 'g', state: 'COMPLETE', dispatches: 2, turns: 12,
  inputTokens: 500, outputTokens: 2_000, cacheReadTokens: 400_000, cacheCreationTokens: 0,
  costUsd: 0.42, repositoryRevision: REV, environmentFingerprint: 'v22/org-exec/img',
  ...over,
});

describe('telemetryAnomaly', () => {
  it('passes a row whose cost the tokens could actually produce', () => {
    expect(telemetryAnomaly(ok())).toBeNull();
  });

  it('catches money spent against no tokens', () => {
    expect(telemetryAnomaly(ok({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 })))
      .toContain('zero tokens');
  });

  it('catches the four-turn two-dollar row', () => {
    // The real anomaly from the 2026-09-17 paid run: a headline cost no
    // quantity of the tokens reported alongside it could produce. It went
    // undetected into the primary statistics.
    const anomaly = telemetryAnomaly(ok({
      turns: 4, dispatches: 1, costUsd: 2.00,
      inputTokens: 40, outputTokens: 300, cacheReadTokens: 1_200, cacheCreationTokens: 0,
    }));
    expect(anomaly).toContain('more than');
  });

  it('catches dispatches that ran for no turns', () => {
    expect(telemetryAnomaly(ok({ turns: 0 }))).toContain('zero turns');
    expect(telemetryAnomaly(ok({ dispatches: 0 }))).toContain('no dispatch behind them');
  });

  it('does not flag a row that spent almost nothing', () => {
    expect(telemetryAnomaly({ dispatches: 0, turns: 0, costUsd: 0.001 })).toBeNull();
  });

  it('catches a real dispatch that billed nothing', () => {
    // The 2026-09-20 paid run's signature for an auth token expiring
    // mid-dispatch: a real attempt (dispatches and turns both recorded) that
    // billed zero cost and zero tokens. `ranNothing` in classifyValidity only
    // catches dispatches === 0, so this slipped through as a genuine product
    // FAILED and into the primary statistics.
    expect(telemetryAnomaly(ok({
      dispatches: 1, turns: 1, costUsd: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    }))).toContain('zero cost and zero tokens');
  });

  it('does not flag a genuinely free completion that never dispatched', () => {
    expect(telemetryAnomaly(ok({
      dispatches: 0, turns: 0, costUsd: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    }))).toBeNull();
  });
});

describe('classifyValidity', () => {
  it('keeps a real product failure in the statistics', () => {
    // The distinction the two-bucket classifier could not express: a task the
    // runtime genuinely failed is evidence, not noise.
    expect(classifyValidity(ok({ state: 'FAILED' })).validity).toBe('VALID');
  });

  it('separates infrastructure from environment rather than calling both "environment"', () => {
    expect(classifyValidity({ state: 'UNRUNNABLE', failureKind: 'cluster' }).validity).toBe('INVALID_INFRA');
    expect(classifyValidity({ state: 'UNRUNNABLE', failureKind: 'network' }).validity).toBe('INVALID_INFRA');
    expect(classifyValidity({ state: 'UNRUNNABLE', failureKind: 'credentials' }).validity).toBe('INVALID_ENV');
    expect(classifyValidity({ state: 'UNRUNNABLE', failureKind: 'rate_limited' }).validity).toBe('INVALID_ENV');
  });

  it('does not call an unclassified launch failure a product failure', () => {
    expect(classifyValidity({ state: 'UNRUNNABLE', failureKind: 'unknown' }).validity).toBe('INVALID_INFRA');
  });

  it('refuses a row that ran against a different snapshot', () => {
    const verdict = classifyValidity(ok({ repositoryRevision: 'b'.repeat(40) }), { repositoryRevision: REV });
    expect(verdict.validity).toBe('INVALID_SNAPSHOT');
    expect(verdict.reason).toContain('expected');
  });

  it('checks the snapshot before the telemetry', () => {
    // A row from the wrong tree is not evidence however clean its numbers are,
    // and reporting it as a telemetry problem would send the wrong person
    // looking.
    const verdict = classifyValidity(
      ok({ repositoryRevision: 'b'.repeat(40), costUsd: 99, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }),
      { repositoryRevision: REV },
    );
    expect(verdict.validity).toBe('INVALID_SNAPSHOT');
  });

  it('marks a cancelled run aborted rather than failed', () => {
    expect(classifyValidity(ok({ state: 'CANCELLED' })).validity).toBe('ABORTED');
  });

  it('does not read an auth-rejected dispatch as a real product failure', () => {
    // Observed live: an oauth token expired mid-benchmark, and every dispatch
    // after that failed in ~8 seconds with dispatches: 1, turns: 1 and
    // nothing billed. classifyValidity's ranNothing path only fires when
    // dispatches === 0, so this reached VALID/"a real product failure" and
    // sat in the same statistics as goals that actually ran.
    const verdict = classifyValidity(ok({
      state: 'FAILED', dispatches: 1, turns: 1, costUsd: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    }));
    expect(verdict.validity).toBe('INVALID_TELEMETRY');
  });
});

describe('partitionByValidity', () => {
  it('counts what it excluded and says so', () => {
    const partition = partitionByValidity([
      ok(), ok({ state: 'FAILED' }),
      ok({ costUsd: 2.0, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }),
      { state: 'UNRUNNABLE', failureKind: 'credentials' },
    ], { repositoryRevision: REV });

    expect(partition.counts.VALID).toBe(2);
    expect(partition.counts.INVALID_TELEMETRY).toBe(1);
    expect(partition.counts.INVALID_ENV).toBe(1);
    expect(partition.valid).toHaveLength(2);
    expect(renderValidity(partition)).toContain('valid 2 of 4');
    expect(renderValidity(partition)).toContain('INVALID_TELEMETRY: 1');
  });

  it('says outright when a run establishes nothing', () => {
    const partition = partitionByValidity([{ state: 'UNRUNNABLE', failureKind: 'cluster' }]);
    expect(renderValidity(partition)).toContain('NOTHING VALID');
  });
});

describe('a node that never ran', () => {
  it('is infrastructure, not a product failure', () => {
    // Observed live: with no cluster available, `org run` succeeds, the node is
    // created, and it dies without dispatching. The two-bucket classifier and
    // the launch-exception path both miss it, so it read as "the runtime tried
    // and failed" — the most expensive kind of wrong row to have in a mean.
    const verdict = classifyValidity({
      state: 'FAILED', dispatches: 0, turns: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0,
    });
    expect(verdict.validity).toBe('INVALID_INFRA');
    expect(verdict.reason).toContain('without dispatching');
  });

  it('still counts a failure that actually ran as a product result', () => {
    expect(classifyValidity(ok({ state: 'FAILED' })).validity).toBe('VALID');
  });

  it('does not reclassify a genuinely free completion', () => {
    // A cache hit completes having dispatched nothing, and that is a success.
    expect(classifyValidity({
      state: 'COMPLETE', dispatches: 0, turns: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0,
    }).validity).toBe('VALID');
  });

  it('is not fooled by real cache-creation activity into looking like it never ran', () => {
    // ranNothing's zero-check used to omit cacheCreationTokens, even though
    // telemetryAnomaly's own token total three lines above it includes that
    // field. A row reporting only cache-creation tokens (no read, no
    // input/output, zero recorded dispatches/turns) reached
    // INVALID_INFRA/"without dispatching anything" despite the ledger
    // showing real, billable activity.
    const verdict = classifyValidity({
      state: 'FAILED', dispatches: 0, turns: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 5_000, costUsd: 0,
    });
    expect(verdict.validity).toBe('VALID');
  });

  it('still catches nothing happening when only the cost is a rounding artifact', () => {
    // A row that never dispatched but reports $0.001 instead of an exact $0
    // — plausible rounding noise — satisfied neither ranNothing (costUsd ===
    // 0 exactly) nor telemetryAnomaly's cost-vs-tokens check (needs cost >
    // NEGLIGIBLE_USD), and fell through to VALID.
    const verdict = classifyValidity({
      state: 'FAILED', dispatches: 0, turns: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0.001,
    });
    expect(verdict.validity).toBe('INVALID_INFRA');
  });
});
