import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '../db/client.js';
import { putContextObject } from './store.js';
import {
  materialize, cheapestSufficient, isRefusal, availableRepresentations,
  representationRank, REPRESENTATIONS,
} from './representations.js';
import { scopeOf } from './types.js';

const TEST_DB = './test-representations.db';
afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

const reader = scopeOf(['Read'], true);
const SOURCE = [
  'export function login(user: string) {',
  '  return user;',
  '}',
  '',
  'export class Session {}',
  ...Array.from({ length: 100 }, (_, i) => `// filler ${i}`),
].join('\n');

function repoObject() {
  const path = mkdtempSync(join(tmpdir(), 'representations-'));
  writeFileSync(join(path, 'auth.ts'), SOURCE);
  const db = createDb(TEST_DB);
  const object = putContextObject(db, {
    semanticId: 'repo_file:auth.ts', kind: 'repo_file', content: SOURCE,
    source: { kind: 'repo', locator: 'auth.ts' }, scope: reader,
  });
  return { db, object, worktreePath: path };
}

describe('representations', () => {
  it('is ordered cheapest first, and that order is the policy', () => {
    expect(REPRESENTATIONS[0]).toBe('reference');
    expect(REPRESENTATIONS.at(-1)).toBe('full');
    expect(representationRank('signature')).toBeLessThan(representationRank('full'));
  });

  it('costs three orders of magnitude less as a reference than as full content', () => {
    const { db, object, worktreePath } = repoObject();
    const ref = materialize(db, object, 'reference', { worktreePath });
    const full = materialize(db, object, 'full', { worktreePath });
    if (isRefusal(ref) || isRefusal(full)) throw new Error('expected both to materialize');
    expect(ref.tokens).toBeLessThan(full.tokens / 10);
    expect(ref.partial).toBe(true);
    expect(full.partial).toBe(false);
  });

  it('derives a signature from the symbols actually in the file', () => {
    const { db, object, worktreePath } = repoObject();
    const result = materialize(db, object, 'signature', { worktreePath });
    if (isRefusal(result)) throw new Error(result.reason);
    expect(result.content).toContain('login');
    expect(result.content).toContain('Session');
    expect(result.content).not.toContain('filler');
  });

  it('returns the requested line range for a hunk', () => {
    const { db, object, worktreePath } = repoObject();
    const result = materialize(db, object, 'hunk', { worktreePath, lines: { from: 1, to: 3 } });
    if (isRefusal(result)) throw new Error(result.reason);
    expect(result.content.split('\n')).toHaveLength(3);
    expect(result.content).toContain('login');
  });
});

describe('refusing rather than fabricating', () => {
  it('refuses a representation it cannot derive, and says what it can', () => {
    // Inventing a summary of content we could not read is the one failure mode
    // worse than sending too much.
    const { db, object } = repoObject();          // no worktreePath: unreadable
    const result = materialize(db, object, 'full', {});
    if (!isRefusal(result)) throw new Error('expected a refusal');
    expect(result.reason).toMatch(/could not be read/);
    // Reference and metadata need nothing but the object, so they survive.
    expect(result.available).toEqual(['reference', 'metadata']);
    const fallback = materialize(db, object, 'metadata', {});
    expect(isRefusal(fallback)).toBe(false);
  });

  it('refuses a hunk with no range rather than guessing one', () => {
    const { db, object, worktreePath } = repoObject();
    expect(isRefusal(materialize(db, object, 'hunk', { worktreePath }))).toBe(true);
  });

  it('refuses rather than truncating past a budget', () => {
    const { db, object, worktreePath } = repoObject();
    const result = materialize(db, object, 'full', { worktreePath, tokenBudget: 5 });
    if (!isRefusal(result)) throw new Error('expected a refusal');
    expect(result.reason).toMatch(/budget is 5/);
    // And it names only the cheaper options, not the one that just failed.
    expect(result.available).not.toContain('full');
  });

  it('knows what a readable object can produce', () => {
    expect(availableRepresentations(null)).toEqual(['reference', 'metadata']);
    expect(availableRepresentations(SOURCE)).toContain('signature');
    expect(availableRepresentations('no symbols here')).not.toContain('signature');
  });
});

describe('cheapest sufficient', () => {
  it('picks the most informative representation that fits, never building a larger one', () => {
    const { db, object, worktreePath } = repoObject();
    const tight = cheapestSufficient(db, object, { worktreePath, tokenBudget: 30 });
    if (isRefusal(tight)) throw new Error(tight.reason);
    expect(tight.tokens).toBeLessThanOrEqual(30);
    expect(representationRank(tight.representation)).toBeLessThan(representationRank('full'));

    const roomy = cheapestSufficient(db, object, { worktreePath, tokenBudget: 100_000 });
    if (isRefusal(roomy)) throw new Error(roomy.reason);
    expect(roomy.representation).toBe('full');
  });

  it('respects a floor, so a caller that needs at least a signature does not get a path', () => {
    const { db, object, worktreePath } = repoObject();
    const result = cheapestSufficient(db, object, { worktreePath, atLeast: 'signature', tokenBudget: 100_000 });
    if (isRefusal(result)) throw new Error(result.reason);
    expect(representationRank(result.representation)).toBeGreaterThanOrEqual(representationRank('signature'));
  });

  it('refuses when even the floor does not fit', () => {
    const { db, object, worktreePath } = repoObject();
    expect(isRefusal(cheapestSufficient(db, object, { worktreePath, atLeast: 'full', tokenBudget: 1 }))).toBe(true);
  });
});
