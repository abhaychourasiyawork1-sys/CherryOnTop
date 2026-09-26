import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMarketingDb, type MarketingDb } from './db.js';
import { addToWaitlist, countWaitlistSignups } from './waitlist.js';
import { waitlistRequestSchema } from './schemas.js';

describe('addToWaitlist', () => {
  let db: MarketingDb;

  beforeEach(() => {
    db = createMarketingDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('accepts a valid email', () => {
    const parsed = waitlistRequestSchema.parse({ email: 'Person@Example.com' });
    const result = addToWaitlist(db, parsed);
    expect(result).toEqual({ accepted: true });
    expect(countWaitlistSignups(db)).toBe(1);
  });

  it('normalizes whitespace and case', () => {
    const parsed = waitlistRequestSchema.parse({ email: '  Person@Example.COM  ' });
    addToWaitlist(db, parsed);
    const row = db.raw.prepare('SELECT email FROM waitlist_signups').get() as { email: string };
    expect(row.email).toBe('person@example.com');
  });

  it('is idempotent for duplicate emails and does not error', () => {
    const parsed = waitlistRequestSchema.parse({ email: 'dup@example.com' });
    const first = addToWaitlist(db, parsed);
    const second = addToWaitlist(db, parsed);
    expect(first).toEqual({ accepted: true });
    expect(second).toEqual({ accepted: true });
    expect(countWaitlistSignups(db)).toBe(1);
  });

  it('accepts honeypot submissions without creating a row', () => {
    const parsed = waitlistRequestSchema.parse({ email: 'bot@example.com', honeypot: 'filled' });
    const result = addToWaitlist(db, parsed);
    expect(result).toEqual({ accepted: true });
    expect(countWaitlistSignups(db)).toBe(0);
  });

  it('rejects invalid emails at the schema layer', () => {
    expect(() => waitlistRequestSchema.parse({ email: 'not-an-email' })).toThrow();
  });

  it('persists across reopening the database file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cherryontop-marketing-'));
    const dbPath = path.join(dir, 'marketing.db');
    const firstHandle = createMarketingDb(dbPath);
    addToWaitlist(firstHandle, waitlistRequestSchema.parse({ email: 'persist@example.com' }));
    firstHandle.close();

    const secondHandle = createMarketingDb(dbPath);
    expect(countWaitlistSignups(secondHandle)).toBe(1);
    secondHandle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
