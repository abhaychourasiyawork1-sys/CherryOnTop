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

const value = { text: 'Two bugs found in src/auth.', tokens: 1_772_218, costUsd: 0.947 };

describe('resultCacheKey', () => {
  it('is the same for the same question asked the same way', () => {
    expect(resultCacheKey('review it', 'abc', 'sonnet', ['Read']))
      .toBe(resultCacheKey('review it', 'abc', 'sonnet', ['Read']));
  });

  it('separates every input that could change the answer', () => {
    const base = resultCacheKey('review it', 'abc', 'sonnet', ['Read']);
    expect(resultCacheKey('review them', 'abc', 'sonnet', ['Read'])).not.toBe(base);
    // A different commit is a different repository. This is the whole validity
    // rule: the answer describes the code as it stood.
    expect(resultCacheKey('review it', 'def', 'sonnet', ['Read'])).not.toBe(base);
    // A haiku answer must not be served to a request routed to sonnet.
    expect(resultCacheKey('review it', 'abc', 'haiku', ['Read'])).not.toBe(base);
    // An answer produced under a wider grant saw more than this node may.
    expect(resultCacheKey('review it', 'abc', 'sonnet', ['Read', 'Grep'])).not.toBe(base);
    expect(resultCacheKey('review it', 'abc', 'sonnet', null)).not.toBe(base);
  });

  it('does not depend on the order the grant happens to be listed in', () => {
    expect(resultCacheKey('g', 'h', 'm', ['Grep', 'Read']))
      .toBe(resultCacheKey('g', 'h', 'm', ['Read', 'Grep']));
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
    putCachedResult(db, 'bad', { text: '   ', tokens: 1, costUsd: 0 }, now);
    expect(getCachedResult(db, 'bad', 24)).toBeNull();
    putCachedResult(db, 'worse', { text: 42 as unknown as string, tokens: 1, costUsd: 0 }, now);
    expect(getCachedResult(db, 'worse', 24)).toBeNull();
  });

  it('serves the newest row for a key', () => {
    const db = createDb(TEST_DB);
    putCachedResult(db, 'k', { ...value, text: 'older' }, '2026-09-01T00:00:00.000Z');
    putCachedResult(db, 'k', { ...value, text: 'newer' }, new Date().toISOString());
    expect(getCachedResult(db, 'k', 24 * 365)?.text).toBe('newer');
  });
});
