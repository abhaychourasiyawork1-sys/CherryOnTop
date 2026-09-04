import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { unlinkSync, existsSync } from 'node:fs';
import { nodes } from './schema.js';

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
});
