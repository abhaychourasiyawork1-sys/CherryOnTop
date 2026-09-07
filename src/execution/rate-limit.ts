import type { StructuredEvent } from '../adapters/adapter.js';

/** A refused request because the subscription's usage window is spent.
 *
 *  The runtime streams this as a `rate_limit_event` carrying the exact window
 *  and reset time, and we used to ignore it — so an exhausted quota was reported
 *  as "Request timed out" and surfaced as "Cannot reach the model API". That
 *  sends you to debug networking for something no amount of retrying can fix,
 *  and each retry spends more of the quota that is already gone. */
export interface RateLimited {
  /** Which window ran out, in the runtime's own words ('five_hour', 'seven_day'). */
  window: string;
  /** Unix seconds. Undefined when the runtime did not say. */
  resetsAtSeconds?: number;
}

interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
}

function fromPayload(payload: unknown): RateLimited | null {
  const info = (payload as { rate_limit_info?: RateLimitInfo } | null)?.rate_limit_info;
  // Informational events report the window filling up; only a rejection means
  // the request was actually refused.
  if (info?.status !== 'rejected') return null;
  return {
    window: info.rateLimitType ?? 'usage',
    resetsAtSeconds: typeof info.resetsAt === 'number' ? info.resetsAt : undefined,
  };
}

/** The rate-limit rejection in a run's events, if there was one. */
export function rateLimitFromEvents(events: StructuredEvent[]): RateLimited | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type !== 'rate_limit_event') continue;
    const limited = fromPayload(event.payload);
    if (limited) return limited;
  }
  return null;
}

const WINDOW_NAMES: Record<string, string> = {
  five_hour: 'five-hour',
  seven_day: 'seven-day',
};

/** Written for whoever is watching, not for a log: what ran out, when it comes
 *  back, and what they can do about it now. */
export function describeRateLimit(limited: RateLimited, now: Date = new Date()): string {
  const window = WINDOW_NAMES[limited.window] ?? limited.window;
  const parts = [`Your Claude ${window} usage limit is used up, so the request was refused.`];

  if (limited.resetsAtSeconds !== undefined) {
    const resetsAt = new Date(limited.resetsAtSeconds * 1000);
    const minutes = Math.max(0, Math.round((resetsAt.getTime() - now.getTime()) / 60_000));
    const when = resetsAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    parts.push(minutes > 0 ? `It resets at ${when}, in about ${formatDelay(minutes)}.` : `It resets at ${when}.`);
  }

  parts.push('Nothing will run until then. Set ANTHROPIC_API_KEY to bill usage separately, or wait.');
  return parts.join(' ');
}

function formatDelay(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
