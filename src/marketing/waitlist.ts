import { randomUUID } from 'node:crypto';
import type { MarketingDb } from './db.js';
import type { WaitlistRequest } from './schemas.js';

export interface WaitlistResult {
  accepted: true;
}

export function addToWaitlist(db: MarketingDb, input: WaitlistRequest): WaitlistResult {
  if (input.honeypot) {
    return { accepted: true };
  }

  db.raw
    .prepare(
      `INSERT OR IGNORE INTO waitlist_signups (id, email, intent, consent_version, created_at)
       VALUES (@id, @email, @intent, @consentVersion, @createdAt)`,
    )
    .run({
      id: randomUUID(),
      email: input.email,
      intent: input.intent ?? null,
      consentVersion: input.consentVersion ?? null,
      createdAt: new Date().toISOString(),
    });

  return { accepted: true };
}

export function countWaitlistSignups(db: MarketingDb): number {
  const row = db.raw.prepare('SELECT COUNT(*) as count FROM waitlist_signups').get() as { count: number };
  return row.count;
}
