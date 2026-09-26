# CherryOnTop marketing site — analytics contract

First-party interaction telemetry only. No third-party scripts, cookies or fingerprinting.

## Approved events

Defined once in `site/src/analytics/events.ts` and mirrored by the server allow-list in
`src/marketing/telemetry.ts`; anything else is rejected.

| Event | Fired when |
|---|---|
| `hero_cta_clicked` | primary hero CTA clicked |
| `video_started` | promo video starts playing (once per page view) |
| `organization_explored` | an organization node is inspected (`node` metadata) |
| `mandate_explored` | the mandate/authority panel is explored |
| `receipt_opened` | the decision receipt is expanded |
| `architecture_explored` | an architecture layer is expanded |
| `benchmark_viewed` | the benchmark section is viewed |
| `launch_form_started` | first interaction with the launch form |
| `launch_form_submitted` | launch form submitted (no email or form content) |

## Safe metadata rules

- At most 8 entries; keys ≤ 40 chars; string values ≤ 120 chars; values are string/number/boolean.
- Keys matching `email|repo|path|model|provider|name|content|message|text|query` are dropped.
- String values that look like emails or paths (`@`, `a/b`) are dropped.
- The same rules are enforced twice: client-side (`sanitizeMetadata`) and server-side (Zod schema).

## No-PII policy

Never collected or stored: email addresses, IP addresses (used in memory for rate limiting
only), repository paths, model/provider names, free-form user text. The session id is a random
identifier held in memory for one page load (no cookie/storage), not linked to the waitlist.

## Transport and batching

- Events queue in memory and flush in batches of 10 to `POST /api/analytics`
  (same origin, JSON); on `pagehide`/hidden visibility the queue flushes with `sendBeacon`.
- Server accepts ≤ 20 events per batch, 20 KB body limit, 120 requests/min per client.

## Retention

`marketing_events` rows are deleted by `npm run marketing:prune-telemetry -- <days>`
(`TelemetryStore.deleteOlderThan`). Schedule it; see `docs/marketing/operations.md`.
