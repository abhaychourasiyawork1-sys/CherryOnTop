import { z } from 'zod';
import type { MarketingDb } from './db.js';

export const ANALYTICS_EVENT_NAMES = [
  'hero_cta_clicked',
  'video_started',
  'organization_explored',
  'mandate_explored',
  'receipt_opened',
  'architecture_explored',
  'benchmark_viewed',
  'launch_form_started',
  'launch_form_submitted',
] as const;

export const MAX_EVENTS_PER_BATCH = 20;
const FORBIDDEN_KEY_PATTERN = /email|e-mail|repo|path|model|provider|name|content|message|text|query/i;
const PII_LIKE_VALUE_PATTERN = /@|\/[^/]+\/[^/]+|[\w.-]+\/[\w.-]+/;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

const metadataSchema = z
  .record(z.string().min(1).max(40), z.union([z.string().max(120), z.number().finite(), z.boolean()]))
  .refine((value) => Object.keys(value).length <= 8)
  .refine((value) =>
    Object.entries(value).every(
      ([key, entry]) =>
        !FORBIDDEN_KEY_PATTERN.test(key) && (typeof entry !== 'string' || !PII_LIKE_VALUE_PATTERN.test(entry)),
    ),
  );

const eventSchema = z
  .object({
    event: z.enum(ANALYTICS_EVENT_NAMES),
    path: z.string().min(1).max(200).startsWith('/'),
    timestamp: z.string().datetime(),
    metadata: metadataSchema.optional(),
  })
  .strict();

export const analyticsBatchSchema = z
  .object({
    sessionId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
    events: z.array(eventSchema).min(1).max(MAX_EVENTS_PER_BATCH),
  })
  .strict();

export type AnalyticsBatch = z.infer<typeof analyticsBatchSchema>;
export type AnalyticsEvent = AnalyticsBatch['events'][number];

export interface TelemetryStore {
  insertBatch(sessionId: string, events: AnalyticsEvent[], now?: Date): number;
  deleteOlderThan(retentionDays: number, now?: Date): number;
  count(): number;
}

export function createTelemetryStore(db: MarketingDb): TelemetryStore {
  const insert = db.raw.prepare(
    'INSERT INTO marketing_events (event, session_id, path, metadata, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const insertMany = db.raw.transaction((sessionId: string, events: AnalyticsEvent[], now: Date) => {
    for (const item of events) {
      const clientTime = Date.parse(item.timestamp);
      const createdAt =
        clientTime <= now.getTime() + MAX_CLOCK_SKEW_MS ? new Date(clientTime).toISOString() : now.toISOString();
      insert.run(item.event, sessionId, item.path, JSON.stringify(item.metadata ?? {}), createdAt);
    }
  });

  return {
    insertBatch(sessionId, events, now = new Date()) {
      insertMany(sessionId, events, now);
      return events.length;
    },
    deleteOlderThan(retentionDays, now = new Date()) {
      if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
        throw new Error('retentionDays must be a positive number');
      }
      const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
      return db.raw.prepare('DELETE FROM marketing_events WHERE created_at < ?').run(cutoff).changes;
    },
    count() {
      return (db.raw.prepare('SELECT COUNT(*) AS count FROM marketing_events').get() as { count: number }).count;
    },
  };
}
