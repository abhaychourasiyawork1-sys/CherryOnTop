import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../db/client.js';
import { captureShadow, reconcileShadow, listShadowRecords, summarizeShadow } from './shadow.js';
import { receipt } from '../decision/types.js';

const TEST_DB = './test-shadow.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const ran = receipt({
  chosen: 'RUN_MODEL', reason: 'no reuse available',
  estimate: { tokens: 1_772_218, latencyMs: 263_000, costUsd: 0.95 },
});
const reused = receipt({
  chosen: 'REUSE_COMPUTATION', reason: 'a valid answer exists',
  estimate: { tokens: 0, latencyMs: 0, costUsd: 0 },
});

describe('a shadow is inert', () => {
  it('returns a record, never a decision', () => {
    // There is no way to use this module to decide anything, which is the point.
    const db = createDb(TEST_DB);
    const record = captureShadow(db, { nodeId: 'n1', policy: 'eager-reuse', production: ran, shadow: reused });
    expect(record).not.toHaveProperty('chosen');
    expect(record.production.chosen).toBe('RUN_MODEL');
    expect(record.shadow.chosen).toBe('REUSE_COMPUTATION');
  });

  it('records the predicted difference in the direction that reads correctly', () => {
    // Negative means the shadow would have been cheaper.
    const db = createDb(TEST_DB);
    const record = captureShadow(db, { nodeId: 'n1', policy: 'p', production: ran, shadow: reused });
    expect(record.predictedDelta.tokens).toBe(-1_772_218);
    expect(record.agreed).toBe(false);
  });

  it('notices agreement', () => {
    const db = createDb(TEST_DB);
    expect(captureShadow(db, { nodeId: 'n1', policy: 'p', production: ran, shadow: ran }).agreed).toBe(true);
  });
});

describe('reconciling a prediction against an outcome', () => {
  it('attaches what production actually cost', () => {
    const db = createDb(TEST_DB);
    const record = captureShadow(db, { nodeId: 'n1', policy: 'p', production: ran, shadow: reused });
    reconcileShadow(db, record.id, { tokens: 1_900_000, latencyMs: 280_000, costUsd: 1.02, succeeded: true });
    expect(listShadowRecords(db)[0].actual?.tokens).toBe(1_900_000);
  });

  it('does nothing for a record that does not exist, rather than throwing', () => {
    const db = createDb(TEST_DB);
    expect(() => reconcileShadow(db, 'nope', { tokens: 0, latencyMs: 0, costUsd: 0, succeeded: true })).not.toThrow();
  });
});

describe('summarizing a policy', () => {
  it('counts agreement and names where the two differed', () => {
    const db = createDb(TEST_DB);
    captureShadow(db, { nodeId: 'n1', policy: 'p', production: ran, shadow: reused });
    captureShadow(db, { nodeId: 'n2', policy: 'p', production: ran, shadow: reused });
    captureShadow(db, { nodeId: 'n3', policy: 'p', production: ran, shadow: ran });

    const summary = summarizeShadow(listShadowRecords(db), 'p');
    expect(summary.decisions).toBe(3);
    expect(summary.agreementRate).toBeCloseTo(1 / 3);
    expect(summary.disagreements[0]).toEqual({ production: 'RUN_MODEL', shadow: 'REUSE_COMPUTATION', count: 2 });
    // Agreeing decisions contribute nothing to a comparison.
    expect(summary.predictedTokenDelta).toBe(-3_544_436);
  });

  it('reports no success rate until something has been reconciled', () => {
    // Comparing against unreconciled predictions is two guesses, not a
    // measurement.
    const db = createDb(TEST_DB);
    captureShadow(db, { nodeId: 'n1', policy: 'p', production: ran, shadow: reused });
    expect(summarizeShadow(listShadowRecords(db), 'p').productionSuccessRate).toBeNull();
  });

  it('keeps several policies apart', () => {
    const db = createDb(TEST_DB);
    captureShadow(db, { nodeId: 'n1', policy: 'a', production: ran, shadow: reused });
    captureShadow(db, { nodeId: 'n2', policy: 'b', production: ran, shadow: ran });
    expect(summarizeShadow(listShadowRecords(db), 'a').decisions).toBe(1);
    expect(listShadowRecords(db, 'b')).toHaveLength(1);
  });

  it('is vacuously in agreement when nothing has been captured', () => {
    expect(summarizeShadow([], 'p')).toMatchObject({ decisions: 0, agreementRate: 1 });
  });
});
