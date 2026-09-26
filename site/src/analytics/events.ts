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

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];

export type AnalyticsMetadataValue = string | number | boolean;
export type AnalyticsMetadata = Record<string, AnalyticsMetadataValue>;

export interface QueuedAnalyticsEvent {
  event: AnalyticsEventName;
  metadata?: AnalyticsMetadata;
  path: string;
  timestamp: string;
}

const MAX_METADATA_ENTRIES = 8;
const MAX_METADATA_KEY_LENGTH = 40;
const MAX_METADATA_VALUE_LENGTH = 120;
const PII_LIKE_PATTERN = /@|\/[^/]+\/[^/]+|[\w.-]+\/[\w.-]+/;
const FORBIDDEN_KEY_PATTERN = /email|e-mail|repo|path|model|provider|name|content|message|text|query/i;

export function isAnalyticsEventName(value: unknown): value is AnalyticsEventName {
  return typeof value === 'string' && (ANALYTICS_EVENT_NAMES as readonly string[]).includes(value);
}

export function sanitizeMetadata(metadata?: Record<string, unknown>): AnalyticsMetadata | undefined {
  if (!metadata) return undefined;

  const result: AnalyticsMetadata = {};
  let count = 0;

  for (const [key, value] of Object.entries(metadata)) {
    if (count >= MAX_METADATA_ENTRIES) break;
    if (key.length === 0 || key.length > MAX_METADATA_KEY_LENGTH) continue;
    if (FORBIDDEN_KEY_PATTERN.test(key)) continue;

    if (typeof value === 'string') {
      if (value.length > MAX_METADATA_VALUE_LENGTH) continue;
      if (PII_LIKE_PATTERN.test(value)) continue;
      result[key] = value;
      count += 1;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
      count += 1;
    }
  }

  return count > 0 ? result : undefined;
}
