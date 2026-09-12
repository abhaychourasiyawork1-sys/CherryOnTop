import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../client.js';
import { resultCacheKey, getCachedResult, putCachedResult } from './result-cache.js';

const TEST_DB = './test-result-cache.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const deps = { head: 'abc', files: { 'src/auth.ts': 'sha1' }, dirs: {}, opaque: false };
const value = { text: 'Two bugs found in src/auth.', tokens: 1_772_218, costUsd: 0.947, deps };

describe('resultCacheKey', () => {
  it('is the same for the same question asked the same way', () => {
    expect(resultCacheKey('review it', 'sonnet', ['Read']))
      .toBe(resultCacheKey('review it', 'sonnet', ['Read']));
  });

  it('separates every input that identifies a different question', () => {
    const base = resultCacheKey('review it', 'sonnet', ['Read']);
    expect(resultCacheKey('review them', 'sonnet', ['Read'])).not.toBe(base);
    // A haiku answer must not be served to a request routed to sonnet.
    expect(resultCacheKey('review it', 'haiku', ['Read'])).not.toBe(base);
    // An answer produced under a wider grant saw more than this node may.
    expect(resultCacheKey('review it', 'sonnet', ['Read', 'Grep'])).not.toBe(base);
    expect(resultCacheKey('review it', 'sonnet', null)).not.toBe(base);
  });

  it('does not depend on the order the grant happens to be listed in', () => {
    expect(resultCacheKey('g', 'm', ['Grep', 'Read']))
      .toBe(resultCacheKey('g', 'm', ['Read', 'Grep']));
  });
});

describe('the result cache', () => {
  it('returns what was stored, within the TTL', () => {
    const db = createDb(TEST_DB);
    putCachedResult(db, 'k', value, new Date().toISOString());
    expect(getCachedResult(db, 'k', 24)).toEqual(value);
  });

  it('misses on an unknown key, a zero TTL and an expired row', () => {
    const db = createDb(TEST_DB);
    putCachedResult(db, 'k', value, new Date(Date.now() - 48 * 3_600_000).toISOString());
    expect(getCachedResult(db, 'nope', 24)).toBeNull();
    expect(getCachedResult(db, 'k', 0)).toBeNull();
    expect(getCachedResult(db, 'k', 24)).toBeNull();
    expect(getCachedResult(db, 'k', 72)).toEqual(value);
  });

  it('refuses a malformed or empty row rather than serving it as an answer', () => {
    const db = createDb(TEST_DB);
    const now = new Date().toISOString();
    putCachedResult(db, 'bad', { text: '   ', tokens: 1, costUsd: 0, deps }, now);
    expect(getCachedResult(db, 'bad', 24)).toBeNull();
    putCachedResult(db, 'worse', { text: 42 as unknown as string, tokens: 1, costUsd: 0, deps }, now);
    expect(getCachedResult(db, 'worse', 24)).toBeNull();
  });

  it('serves the newest row for a key', () => {
    const db = createDb(TEST_DB);
    putCachedResult(db, 'k', { ...value, text: 'older' }, '2026-09-01T00:00:00.000Z');
    putCachedResult(db, 'k', { ...value, text: 'newer' }, new Date().toISOString());
    expect(getCachedResult(db, 'k', 24 * 365)?.text).toBe('newer');
  });

  it('asks every row whether it is still valid, not only the newest', () => {
    // An answer given against a commit the tree has since moved past can be
    // stale while an older one — taken against files nothing has touched — is
    // still true. Checking only the newest would throw that away.
    const db = createDb(TEST_DB);
    const now = new Date().toISOString();
    putCachedResult(db, 'k', { ...value, text: 'still true' }, '2026-09-11T00:00:00.000Z');
    putCachedResult(db, 'k', { ...value, text: 'now stale' }, now);
    const valid = getCachedResult(db, 'k', 24 * 365, (v) => v.text === 'still true');
    expect(valid?.text).toBe('still true');
    expect(getCachedResult(db, 'k', 24 * 365, () => false)).toBeNull();
  });
});
