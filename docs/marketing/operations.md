# CherryOnTop marketing site — operations

All operations below need **local filesystem access** to the marketing database
(`MARKETING_DB_PATH`, default `~/.cherryontop/marketing.db`). There is deliberately no HTTP
endpoint for exporting or administering waitlist data.

The marketing DB holds only two tables: `waitlist_signups` (email, intent, consent version,
created timestamp) and `marketing_events` (first-party telemetry with no email, IP, repository
path, model/provider name or free-form text). It is separate from the runtime daemon's database.

## Check API health

```bash
node -e "fetch('http://127.0.0.1:4178/api/health').then(r=>r.json()).then(console.log)"
# or through the public origin: curl -fsS https://<domain>/api/health
```

Expected: HTTP 200 with `{"status":"ok"}`. The response never includes filesystem paths.

## Back up the database

The server runs SQLite in WAL mode; copy it with SQLite's online backup, not `cp`:

```bash
sqlite3 "$MARKETING_DB_PATH" ".backup '/backups/marketing-$(date -u +%Y%m%dT%H%M%SZ).db'"
```

Schedule this (e.g. daily cron / systemd timer), keep backups encrypted and access-restricted —
they contain email addresses — and test a restore periodically by pointing a local server at a
backup copy with `MARKETING_DB_PATH=<copy> npm run marketing:start`.

## Export the waitlist

```bash
npm run marketing:export -- ./waitlist.csv                 # uses MARKETING_DB_PATH
npm run marketing:export -- ./waitlist.csv /path/to/marketing.db
```

- Output columns: `email,intent,consent_version,created_at` (CRLF CSV, oldest first).
- Telemetry is never included.
- The DB is opened read-only and must already exist; the file is written with mode `600`.
- Cells beginning with `= + - @` are prefixed with `'` so spreadsheets do not execute them.
- Treat the CSV as personal data: delete it once imported into the mailing tool.

## Prune telemetry

```bash
npm run marketing:prune-telemetry -- 90                    # keep the last 90 days
npm run marketing:prune-telemetry -- 90 /path/to/marketing.db
```

Deletes `marketing_events` rows older than the retention window; the waitlist is untouched. Run
it on a schedule (e.g. daily) with the retention period stated in your privacy notice.

## Rotate host / environment configuration

1. Edit `.env.marketing` (or the secret store backing it). The service has no API secrets; the
   sensitive settings are `MARKETING_DB_PATH`, `MARKETING_TRUST_PROXY`,
   `MARKETING_ALLOWED_ORIGIN` and `MARKETING_MEDIA_ORIGIN`.
2. For a new hostname or origin: rebuild the site with the new `VITE_SITE_ORIGIN`
   (`npm run marketing:build`), update DNS/TLS on the proxy, and update
   `MARKETING_ALLOWED_ORIGIN` if cross-origin callers exist.
3. Changing `MARKETING_CONSENT_VERSION` requires rebuilding the site with a matching
   `VITE_MARKETING_CONSENT_VERSION`; otherwise the server rejects form submissions.
4. Restart: send `SIGTERM` (the server closes the listener and DB cleanly), start it again, then
   run the smoke checks in `docs/marketing/deployment.md`.
5. When moving hosts, stop the old server first, take an online backup, restore it on the new host
   and point `MARKETING_DB_PATH` at it.

## Before launch: confirm benchmark evidence

`docs/marketing/benchmarks.md` is published with the site. It states only what the landing-page
spec sources: SWE-bench Verified, 6 tasks × 3 repetitions = 18 runs, controlled paired
comparison, 18 / 18 resolved, ~15% lower mean cost/run and ~15% fewer mean tokens/run. The
repository holds no raw run data behind these figures. Before launch, the benchmark owner must
confirm them against the run records and, if they are to be published, add to that document:

1. what the comparison arm was (described without competitor, provider, or model names);
2. what "cost" includes (e.g. API spend only, or infrastructure too) and how tokens were counted;
3. the resolution criterion used and the comparison arm's own resolved count;
4. what was held constant between arms, and when the runs were made.

Any figure change must update `benchmarks.md` and `site/src/content.ts` together.
