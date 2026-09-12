import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, type Db } from '../../src/db/client.js';

export interface TestDatabase {
  db: Db;
  path: string;
  cleanup(): void;
}

/** Creates a database that is unique to one test and removes its WAL files. */
export function createTestDatabase(): TestDatabase {
  const directory = mkdtempSync(join(tmpdir(), 'cherryontop-db-'));
  const path = join(directory, 'test.db');
  const db = createDb(path);
  return {
    db,
    path,
    cleanup() {
      try { db.$client.close(); } catch { /* already closed */ }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
