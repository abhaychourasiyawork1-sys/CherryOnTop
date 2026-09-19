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
