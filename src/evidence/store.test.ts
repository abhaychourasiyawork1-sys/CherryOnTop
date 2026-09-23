import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { createDb } from '../db/client.js';
import {
  putKnowledge, queryKnowledge, getKnowledge, invalidateKnowledge,
  recordConflict, recordContradiction, resolveConflict, listConflicts, MAX_QUERY_LIMIT,
  type PutKnowledgeInput,
} from './store.js';

const DB = './test-evidence-store.db';
afterEach(() => {
  for (const s of ['', '-journal', '-wal', '-shm']) if (existsSync(DB + s)) unlinkSync(DB + s);
});

const REPO = 'github.com/acme/app';

const put = (db: ReturnType<typeof createDb>, over: Partial<PutKnowledgeInput> = {}) =>
  putKnowledge(db, {
    kind: 'fact',
    content: 'refreshSession reads the store before the cookie',
    repository: REPO,
    revision: 'rev-1',
    sourcePaths: ['src/auth/session.ts'],
    sourceSymbols: ['refreshSession'],
    confidence: 0.9,
    createdAt: '2026-09-14T00:00:00.000Z',
    ...over,
  });

describe('storing a validated fact with its provenance', () => {
  it('keeps everything a reader needs to decide whether to believe it', () => {
    const db = createDb(DB);
    const stored = put(db, { validated: true });
    const read = getKnowledge(db, stored.id)!;
    expect(read).toMatchObject({
      kind: 'fact',
      repository: REPO,
      revision: 'rev-1',
      sourcePaths: ['src/auth/session.ts'],
      sourceSymbols: ['refreshSession'],
      confidence: 0.9,
      validated: true,
    });
    expect(read.createdAt).toBe('2026-09-14T00:00:00.000Z');
  });

  it('keeps validated and asserted as different objects, not one confidence number', () => {
    const db = createDb(DB);
    const asserted = put(db, { id: 'a', validated: false, confidence: 0.95 });
    const validated = put(db, { id: 'b', validated: true, confidence: 0.6 });
    expect(getKnowledge(db, asserted.id)!.validated).toBe(false);
    expect(getKnowledge(db, validated.id)!.validated).toBe(true);
  });

  it('clamps a nonsense confidence rather than storing it', () => {
    const db = createDb(DB);
    expect(put(db, { confidence: 7 }).confidence).toBe(1);
    expect(put(db, { confidence: -1 }).confidence).toBe(0);
  });

  it('normalizes provenance so two identical claims store identically', () => {
    const db = createDb(DB);
    const a = put(db, { sourcePaths: ['b.ts', 'a.ts', 'a.ts'] });
    const b = put(db, { sourcePaths: ['a.ts', 'b.ts'] });
    expect(a.sourcePaths).toEqual(b.sourcePaths);
  });

  it('returns null for something it does not hold', () => {
    expect(getKnowledge(createDb(DB), 'nope')).toBeNull();
  });
});

describe('finding what bears on the question', () => {
  it('scopes to one repository', () => {
    const db = createDb(DB);
    put(db, { id: 'ours' });
    put(db, { id: 'theirs', repository: 'github.com/other/app' });
    const found = queryKnowledge(db, { repository: REPO, limit: 10 });
    expect(found.map((i) => i.id)).toEqual(['ours']);
  });

  it('puts the same revision first, without hiding the others', () => {
    const db = createDb(DB);
    put(db, { id: 'old', revision: 'rev-0' });
    put(db, { id: 'current', revision: 'rev-1' });
    const found = queryKnowledge(db, { repository: REPO, revision: 'rev-1', limit: 10 });
    expect(found[0].id).toBe('current');
    // A pattern from a neighbouring revision is often exactly what a reader
    // wants, so it is ranked lower rather than dropped.
    expect(found.map((i) => i.id)).toContain('old');
  });

  it('puts validated before asserted at the same revision', () => {
    const db = createDb(DB);
    put(db, { id: 'asserted', validated: false });
    put(db, { id: 'checked', validated: true });
    expect(queryKnowledge(db, { repository: REPO, revision: 'rev-1', limit: 10 })[0].id).toBe('checked');
  });

  it('prefers what overlaps with what was asked for', () => {
    const db = createDb(DB);
    put(db, { id: 'elsewhere', sourcePaths: ['src/billing/invoice.ts'], sourceSymbols: [] });
    put(db, { id: 'here', sourcePaths: ['src/auth/session.ts'], sourceSymbols: [] });
    const found = queryKnowledge(db, { repository: REPO, paths: ['src/auth/session.ts'], limit: 10 });
    expect(found.map((i) => i.id)).toEqual(['here']);
  });

  it('filters by kind', () => {
    const db = createDb(DB);
    put(db, { id: 'f', kind: 'fact' });
    put(db, { id: 'p', kind: 'pattern' });
    expect(queryKnowledge(db, { repository: REPO, kinds: ['pattern'], limit: 10 }).map((i) => i.id))
      .toEqual(['p']);
  });

  it('is deterministic down to the last tie-break', () => {
    const db = createDb(DB);
    for (const id of ['c', 'a', 'b']) put(db, { id });
    const first = queryKnowledge(db, { repository: REPO, limit: 10 }).map((i) => i.id);
    const second = queryKnowledge(db, { repository: REPO, limit: 10 }).map((i) => i.id);
    expect(first).toEqual(second);
    expect(first).toEqual(['a', 'b', 'c']);
  });
});

describe('retrieval is bounded, because that is the whole argument', () => {
  it('honours the caller’s limit', () => {
    const db = createDb(DB);
    for (let i = 0; i < 20; i++) put(db, { id: `k${i}` });
    expect(queryKnowledge(db, { repository: REPO, limit: 5 })).toHaveLength(5);
  });

  it('refuses a limit above its own ceiling', () => {
    const db = createDb(DB);
    for (let i = 0; i < MAX_QUERY_LIMIT + 20; i++) put(db, { id: `k${i}` });
    expect(queryKnowledge(db, { repository: REPO, limit: 10_000 })).toHaveLength(MAX_QUERY_LIMIT);
  });

  it('returns nothing for a zero or negative limit rather than everything', () => {
    const db = createDb(DB);
    put(db);
    expect(queryKnowledge(db, { repository: REPO, limit: 0 })).toEqual([]);
    expect(queryKnowledge(db, { repository: REPO, limit: -5 })).toEqual([]);
  });
});

describe('supersession and withdrawal are different things', () => {
  it('retires the predecessor in the same breath as storing the replacement', () => {
    const db = createDb(DB);
    const first = put(db, { id: 'v1', content: 'reads the cookie first' });
    const second = put(db, {
      id: 'v2', content: 'reads the store first', supersedes: first.id,
      createdAt: '2026-09-15T00:00:00.000Z',
    });

    // Two live answers to one question is exactly what this prevents.
    expect(queryKnowledge(db, { repository: REPO, limit: 10 }).map((i) => i.id)).toEqual([second.id]);
    expect(getKnowledge(db, first.id)!.invalidatedAt).toBe('2026-09-15T00:00:00.000Z');
    expect(getKnowledge(db, second.id)!.supersedes).toBe(first.id);
  });

  it('keeps the chain readable, because what was believed is how a contradiction gets diagnosed', () => {
    const db = createDb(DB);
    const first = put(db, { id: 'v1' });
    put(db, { id: 'v2', supersedes: first.id, createdAt: '2026-09-15T00:00:00.000Z' });
    const withHistory = queryKnowledge(db, { repository: REPO, limit: 10, includeInvalidated: true });
    expect(withHistory.map((i) => i.id).sort()).toEqual(['v1', 'v2']);
  });

  it('withdraws an item without pretending something replaced it', () => {
    const db = createDb(DB);
    const item = put(db, { id: 'wrong' });
    invalidateKnowledge(db, item.id, '2026-09-16T00:00:00.000Z');
    expect(queryKnowledge(db, { repository: REPO, limit: 10 })).toEqual([]);
    const read = getKnowledge(db, item.id)!;
    expect(read.invalidatedAt).toBe('2026-09-16T00:00:00.000Z');
    expect(read.supersedes).toBeUndefined();
  });
});

describe('conflicts are recorded, not resolved', () => {
  it('records two items that cannot both be right', () => {
    const db = createDb(DB);
    const conflict = recordConflict(db, {
      evidenceIds: ['b', 'a'], reason: 'two workstreams disagree about the cookie order', severity: 'high',
    });
    expect(conflict.evidenceIds).toEqual(['a', 'b']);
    expect(conflict.resolved).toBe(false);
    expect(listConflicts(db).map((c) => c.id)).toEqual([conflict.id]);
  });

  it('leaves both items live — picking one silently is the failure mode', () => {
    const db = createDb(DB);
    const a = put(db, { id: 'a', content: 'reads the cookie first' });
    const b = put(db, { id: 'b', content: 'reads the store first' });
    recordConflict(db, { evidenceIds: [a.id, b.id], reason: 'contradiction', severity: 'high' });
    expect(queryKnowledge(db, { repository: REPO, limit: 10 })).toHaveLength(2);
  });

  it('hides a resolved conflict unless asked for it', () => {
    const db = createDb(DB);
    const conflict = recordConflict(db, { evidenceIds: ['a'], reason: 'r', severity: 'low' });
    resolveConflict(db, conflict.id);
    expect(listConflicts(db)).toEqual([]);
    expect(listConflicts(db, { includeResolved: true }).map((c) => c.resolved)).toEqual([true]);
  });
});

describe('recording a contradiction', () => {
  const at = '2026-09-20T00:00:00.000Z';

  it('keeps the disagreement open while serving the claim with precedence', () => {
    const db = createDb(DB);
    const old = put(db, { id: 'old', revision: 'rev-0', content: 'reads the cookie first', validated: true });
    const current = put(db, { id: 'current', revision: 'rev-1', content: 'reads the store first' });

    const { conflict, preferred } = recordContradiction(db, {
      items: [old, current], reason: 'two runs disagree', currentRevision: 'rev-1', at,
    });

    // Evidence about the tree as it stands outranks evidence about the tree as
    // it was — even evidence that was checked.
    expect(preferred?.id).toBe('current');
    // And the conflict stays open: precedence is a working assumption, not an
    // answer to which claim is true.
    expect(conflict.resolved).toBe(false);
    expect(listConflicts(db).map((c) => c.id)).toEqual([conflict.id]);
  });

  it('retires the loser rather than deleting it', () => {
    const db = createDb(DB);
    const old = put(db, { id: 'old', revision: 'rev-0', content: 'a' });
    const current = put(db, { id: 'current', revision: 'rev-1', content: 'b' });
    recordContradiction(db, { items: [old, current], reason: 'r', currentRevision: 'rev-1', at });

    expect(queryKnowledge(db, { repository: REPO, limit: 10 }).map((i) => i.id)).toEqual(['current']);
    // Still readable, because what was believed is how a contradiction gets
    // diagnosed rather than merely observed.
    expect(getKnowledge(db, 'old')!.invalidatedAt).toBe(at);
  });

  it('calls two checked claims disagreeing the worst case', () => {
    const db = createDb(DB);
    const a = put(db, { id: 'a', content: 'x', validated: true });
    const b = put(db, { id: 'b', content: 'y', validated: true, revision: 'rev-2' });
    const { conflict } = recordContradiction(db, { items: [a, b], reason: 'r', at });
    expect(conflict.severity).toBe('high');
  });

  it('invents no winner from an empty set', () => {
    const db = createDb(DB);
    const { preferred } = recordContradiction(db, { items: [], reason: 'r', at });
    expect(preferred).toBeNull();
  });
});
