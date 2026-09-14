import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { unlinkSync, existsSync } from 'node:fs';
import { nodes, knowledge, evidenceConflicts } from './schema.js';

const TEST_DB = './test-schema.db';

afterEach(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
  }
});

describe('schema migration', () => {
  it('creates the nodes table and allows inserting a row', () => {
    const sqlite = new Database(TEST_DB);
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: './src/db/migrations' });

    db.insert(nodes).values({
      id: 'n1',
      parentId: null,
      goal: 'test goal',
      contract: {
        goal: 'test goal',
        definition_of_done: ['done'],
        authority: { tools: [], spawn_children: false, max_child_count: 0, budget_usd: 0 },
        constraints: [],
      },
      state: 'CREATED',
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
    }).run();

    const row = db.select().from(nodes).all()[0];
    expect(row?.id).toBe('n1');
    expect(row?.state).toBe('CREATED');
    sqlite.close();
  });

  it('creates the knowledge table with its provenance columns intact', () => {
    const sqlite = new Database(TEST_DB);
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: './src/db/migrations' });

    db.insert(knowledge).values({
      id: 'k1', kind: 'fact', content: 'refreshSession reads the store first',
      repository: 'github.com/acme/app', revision: 'rev-1',
      sourcePaths: ['src/auth/session.ts'], sourceSymbols: ['refreshSession'],
      confidence: 0.9, validated: true, supersedes: null, invalidatedAt: null,
      createdAt: '2026-09-14T00:00:00.000Z',
    }).run();

    const row = db.select().from(knowledge).all()[0];
    // The revision is the load-bearing column: it is what turns 'this might
    // still be true' into a question with an answer.
    expect(row?.revision).toBe('rev-1');
    expect(row?.sourcePaths).toEqual(['src/auth/session.ts']);
    expect(row?.validated).toBe(true);
    sqlite.close();
  });

  it('indexes the two columns every read filters on', () => {
    const sqlite = new Database(TEST_DB);
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: './src/db/migrations' });

    const indexes = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'knowledge'")
      .all()
      .map((row) => (row as { name: string }).name);
    // A retrieval meant to save tokens that scans the whole table costs more
    // than the search it replaced.
    expect(indexes).toContain('knowledge_repo_revision');
    expect(indexes).toContain('knowledge_repo_kind');
    sqlite.close();
  });

  it('creates the evidence conflict table', () => {
    const sqlite = new Database(TEST_DB);
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: './src/db/migrations' });

    db.insert(evidenceConflicts).values({
      id: 'c1', evidenceIds: ['a', 'b'], reason: 'contradiction', severity: 'high',
      resolved: false, createdAt: '2026-09-14T00:00:00.000Z',
    }).run();

    expect(db.select().from(evidenceConflicts).all()[0]?.evidenceIds).toEqual(['a', 'b']);
    sqlite.close();
  });
});
