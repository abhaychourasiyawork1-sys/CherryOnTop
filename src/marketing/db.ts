import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export interface MarketingDb {
  raw: Database.Database;
  close(): void;
}

const WAITLIST_TABLE = `
CREATE TABLE IF NOT EXISTS waitlist_signups (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  intent TEXT NULL,
  consent_version TEXT NULL,
  created_at TEXT NOT NULL
)`;

const EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS marketing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  metadata TEXT NOT NULL,
  created_at TEXT NOT NULL
)`;

export function createMarketingDb(dbPath: string): MarketingDb {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(WAITLIST_TABLE);
  db.exec(EVENTS_TABLE);

  return {
    raw: db,
    close(): void {
      db.close();
    },
  };
}
