// Provider usage-limit / rate-limit refusals in a run's event stream.
//
// A run the provider refused is not an agent outcome: it is invalid, kept on
// disk for audit, and never enters a validation aggregate or the H2.6
// analysis. The signatures are the runtime's own (src/execution/rate-limit.ts,
// src/intelligence/provider-router.ts), plus an unrecovered API rate-limit or
// overload error as the dispatch's final result. Informational rate-limit
// events (`allowed`, `allowed_warning`) and ordinary agent failures never match.

const USAGE_LIMIT_TEXT = /usage limit is used up/i;
const API_LIMIT_ERROR = /\b(rate_limit_error|overloaded_error)\b/;

/** The first provider refusal in `events` ([{ type, payload }], payload
 *  parsed), as { reason, eventType }, or null. */
export function providerLimit(events) {
  for (const e of events) {
    const p = e.payload ?? {};
    // 1. The provider's own refusal: a rate_limit_event that rejected the request.
    if (/rate_limit_event$/.test(e.type) && p.rate_limit_info?.status === 'rejected') {
      return { reason: `rate_limit_event:rejected:${p.rate_limit_info.rateLimitType ?? 'unknown'}`, eventType: e.type };
    }
    // What the agent itself read or wrote is task content, never a refusal.
    if (/^(exec|plan)\.(assistant|user)$/.test(e.type)) continue;
    const text = typeof p === 'string' ? p : JSON.stringify(p);
    // 2. The runtime's description of that refusal (describeRateLimit).
    if (USAGE_LIMIT_TEXT.test(text)) return { reason: 'usage_limit_message', eventType: e.type };
    // 3. The market refusing every harness because the provider is limited.
    if (text.includes('harness_rate_limited')) return { reason: 'harness_rate_limited', eventType: e.type };
    // 4. A dispatch that ended on an unrecovered provider limit or overload.
    if (/(^|\.)result$/.test(e.type) && p.is_error === true && API_LIMIT_ERROR.test(text)) {
      return { reason: `api_error:${API_LIMIT_ERROR.exec(text)[1]}`, eventType: e.type };
    }
  }
  return null;
}

/** Same, read from a run's preserved database. */
export function providerLimitInDb(db) {
  const rows = db.prepare(`select type, payload from events where type like '%rate_limit_event' or type like '%result'
    or payload like '%usage limit is used up%' or payload like '%harness_rate_limited%' order by id`).all();
  return providerLimit(rows.map((r) => ({ type: r.type, payload: safeJson(r.payload) })));
}

function safeJson(s) { try { return JSON.parse(s); } catch { return s; } }
