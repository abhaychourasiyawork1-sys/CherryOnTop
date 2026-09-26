import { isAnalyticsEventName, sanitizeMetadata, type AnalyticsEventName, type QueuedAnalyticsEvent } from './events';

const ANALYTICS_ENDPOINT = '/api/analytics';
const DEFAULT_BATCH_SIZE = 10;
const MAX_QUEUE_LENGTH = 20;

type Transport = (body: string, onHide: boolean) => Promise<void>;

interface TrackerOptions {
  send: Transport;
  batchSize: number;
}

function defaultSend(body: string, onHide: boolean): Promise<void> {
  if (onHide && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    const queued = navigator.sendBeacon(ANALYTICS_ENDPOINT, new Blob([body], { type: 'application/json' }));
    if (queued) return Promise.resolve();
  }
  if (typeof fetch !== 'function') return Promise.resolve();
  return fetch(ANALYTICS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).then(() => undefined);
}

function createSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

let options: TrackerOptions = { send: defaultSend, batchSize: DEFAULT_BATCH_SIZE };
let sessionId: string | null = null;
let queue: QueuedAnalyticsEvent[] = [];

function currentPath(): string {
  return typeof window === 'undefined' ? '/' : window.location.pathname.slice(0, 200) || '/';
}

function sendQueued(onHide: boolean): Promise<void> {
  if (queue.length === 0) return Promise.resolve();
  sessionId ??= createSessionId();
  const events = queue;
  queue = [];
  const body = JSON.stringify({ sessionId, events });
  try {
    return options.send(body, onHide).catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}

export function track(event: AnalyticsEventName, metadata?: Record<string, string | number | boolean>): void {
  if (!isAnalyticsEventName(event)) return;
  const safeMetadata = sanitizeMetadata(metadata);
  queue.push({
    event,
    ...(safeMetadata ? { metadata: safeMetadata } : {}),
    path: currentPath(),
    timestamp: new Date().toISOString(),
  });
  if (queue.length > MAX_QUEUE_LENGTH) queue = queue.slice(-MAX_QUEUE_LENGTH);
  if (queue.length >= options.batchSize) void sendQueued(false);
}

export function flush(): Promise<void> {
  return sendQueued(false);
}

export function flushOnPageHide(): void {
  void sendQueued(true);
}

export function configureTracker(overrides: Partial<TrackerOptions>): void {
  options = { ...options, ...overrides };
}

export function getQueuedEvents(): readonly QueuedAnalyticsEvent[] {
  return queue;
}

export function resetTracker(): void {
  options = { send: defaultSend, batchSize: DEFAULT_BATCH_SIZE };
  sessionId = null;
  queue = [];
}
