# CherryOnTop marketing site — deployment

The public landing page and its two public APIs (`/api/waitlist`, `/api/analytics`) run as one
standalone Fastify process (`src/marketing/`, started by `scripts/marketing-server.ts`). It is
isolated from the CherryOnTop runtime: it never starts the daemon, Kubernetes jobs, runtime
adapters or tRPC, and it uses its own SQLite file containing only `waitlist_signups` and
`marketing_events`.

## Topology (preferred: same origin)

```text
browser ──TLS──> reverse proxy / CDN ──HTTP──> marketing Fastify (127.0.0.1:4178)
                                                 ├─ /api/health, /api/waitlist, /api/analytics
                                                 ├─ static files from MARKETING_SITE_DIR (site/dist)
                                                 └─ marketing SQLite (MARKETING_DB_PATH)
```

Routing contract (tested in `src/marketing/app.test.ts`):

| Request | Response | `Cache-Control` |
|---|---|---|
| `GET /` | `site/dist/index.html` | `no-cache` (always revalidated) |
| `GET /assets/*` (Vite content-hashed) | file | `public, max-age=31536000, immutable` |
| other files (`/media/*`, `/brand/*`, `robots.txt`, …) | file, byte ranges supported | `public, max-age=3600` |
| `GET/POST /api/*` | JSON | `no-store` |
| unknown `/api/*` | `404 {"error":"not_found"}` — never HTML | `no-store` |
| any other unknown path | plain-text `404` (no SPA fallback; the page uses `#hash` navigation) | `no-cache` |

Every response carries `Content-Security-Policy` (`default-src 'self'`, `frame-ancestors 'none'`,
…), `X-Content-Type-Options: nosniff`, `Referrer-Policy` and `Permissions-Policy`.

## Environment

Copy `.env.marketing.example` to `.env.marketing` (git-ignored) and adjust. Server variables are
read at start-up; `VITE_*` variables are read at **site build time**.

| Variable | Default | Purpose |
|---|---|---|
| `MARKETING_PORT` | `4178` | listener port |
| `MARKETING_HOST` | `127.0.0.1` | listener address; keep loopback behind a local proxy |
| `MARKETING_DB_PATH` | `~/.cherryontop/marketing.db` | dedicated marketing DB — never the runtime DB |
| `MARKETING_SITE_DIR` | `site/dist` | built site root |
| `MARKETING_ALLOWED_ORIGIN` | unset | CORS origin; not needed for same-origin serving |
| `MARKETING_TRUST_PROXY` | `false` | `true` only behind a trusted proxy (see below) |
| `MARKETING_CONSENT_VERSION` | unset | if set, waitlist requests must send this consent version |
| `MARKETING_MEDIA_ORIGIN` | unset | extra CSP `media-src` origin for an off-origin promo video |
| `VITE_PROMO_VIDEO_URL` | `/media/cherryontop-promo.mp4` | promo video URL |
| `VITE_SITE_ORIGIN` | unset | public origin for canonical / `og:url` / absolute share-image URLs |
| `VITE_MARKETING_CONSENT_VERSION` | unset | consent version sent by the launch form |

## Steps

1. **Build the site.**
   ```bash
   npm ci && npm ci --prefix site
   VITE_SITE_ORIGIN=https://<your-domain> npm run marketing:build
   ```
   Without `VITE_SITE_ORIGIN` the build omits the canonical link and `og:url` rather than
   shipping a placeholder domain.
2. **Set the production environment** from `.env.marketing.example`. Put the DB on persistent
   storage writable only by the service user.
3. **Start the marketing server.**
   ```bash
   set -a; . ./.env.marketing; set +a
   npm run marketing:start
   ```
   Run it under a supervisor (systemd, container runtime) with restart-on-failure. `SIGINT` and
   `SIGTERM` close the listener and the SQLite database cleanly.
4. **TLS / reverse proxy / CDN.** Terminate TLS in front of the process (nginx, Caddy, a load
   balancer or a CDN). Forward the whole origin — static files and `/api/*` — so the browser
   stays same-origin. A CDN may cache `/assets/*` (immutable) and must not cache `/api/*`.
5. **Trusted proxy flag.** Set `MARKETING_TRUST_PROXY=true` **only** when every request passes
   through a proxy you control that overwrites `X-Forwarded-For`. Otherwise leave it off: with it
   on and no proxy, clients can forge their address and evade rate limits. Raw client IPs are used
   in memory for rate limiting only, are evicted once their one-minute window expires, and are
   never persisted. Limits are per process: running several instances multiplies the effective limit.
6. **DNS.** Point the public hostname at the proxy/CDN, not at the marketing process directly.
7. **Media origin and CSP.** The default CSP allows media only from `'self'`. If
   `VITE_PROMO_VIDEO_URL` is on another origin, set `MARKETING_MEDIA_ORIGIN` to exactly that origin
   (scheme + host) or the video will be blocked; the page still works via poster + transcript.
8. **Back up the marketing DB** (see `docs/marketing/operations.md`): use SQLite's online backup
   (`sqlite3 "$MARKETING_DB_PATH" ".backup '<file>'"`), not a raw copy of a live WAL database.
9. **Smoke checks** after each deploy:
   ```bash
   curl -fsS https://<domain>/api/health                      # {"status":"ok"}
   curl -fsSI https://<domain>/ | grep -i cache-control        # no-cache
   curl -sS -o /dev/null -w '%{http_code}\n' https://<domain>/api/nope   # 404 (JSON)
   ```
   Then load the page, play the video, and submit the launch form with a test address.
10. **Monitor** `GET /api/health` (200 `{"status":"ok"}`) from your uptime checker, and alert on
    sustained 5xx or 429 rates from the proxy logs.

## Performance and caching notes

- HTML is `no-cache` so a deploy is picked up immediately; hashed assets are immutable, so
  browsers and CDNs never refetch them until their hash changes.
- The promo video is not referenced by the static HTML; it is rendered client-side with a poster,
  and the server supports byte ranges for seeking.

## Launch audit record (Task 24)

Automated evidence (`npm test`, `npm --prefix site test -- --run`):

- Payload limit (413), rate limiting (429), honeypot, generic duplicate response, JSON-only
  content type, malformed JSON → generic 400, DB failure → generic 500 with no internals.
- No raw IPs persisted (DB dump after requests from forged/real addresses contains neither).
- Marketing DB contains only `marketing_events` and `waitlist_signups`; default file
  `marketing.db`; no tRPC/runtime routes registered.
- CSP / nosniff / referrer / permissions headers on every response; `/api/*` is `no-store`.
- `MARKETING_TRUST_PROXY` is on only for the exact string `true`.
- Promo video: no `src` until near the viewport, `preload="none"`, no autoplay under reduced
  motion, paused offscreen; `index.html` references no video.
- Build output (2026-09-26): JS 260 KB (≈81 KB gzip), CSS 23 KB (≈4 KB gzip), HTML ≈1.4 KB;
  the 6.5 MB promo MP4 is fetched only when its section approaches the viewport.
- Content grep over `site/dist` for competitor/model names and "open source": no matches.

Open items (not verifiable or not resolved in the build sandbox):

- Keyboard-only, focus-visible, caption/transcript and contrast checks need a real browser;
  the Playwright suites encode them but were not executed here.
- Footer/nav links to `/docs` and `/security` have no page in `site/dist` and return 404 in
  this same-origin setup; point them at real destinations or remove them before launch.
- `og-image.svg`, `robots.txt` and `sitemap.xml` (Task 18) are not yet in `site/public`.
