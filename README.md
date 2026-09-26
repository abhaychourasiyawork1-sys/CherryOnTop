# CherryOnTop — Public Landing Page (`Webpage` branch)

This branch is intentionally empty except for the seed material below — it is
**not** a copy of the `main` runtime/GUI codebase. It exists to build the
public marketing site described in `docs/cherryontop-landing-page-plan.md`
from scratch, as its own standalone project (`site/` React/Vite app +
`src/marketing/` Fastify service).

## Seed material

- `docs/cherryontop-landing-page-plan.md` — the full task-by-task implementation
  plan. Follow it in order (Section 32: Recommended Execution Order). Every
  task has its own failing-test step, implementation step, and commit.
- `assets/brag/brag.mp4` — the source promo/demo video. Use it as the basis
  for `site/public/media/cherryontop-promo.mp4` (re-encode/trim if needed).
- `assets/brag/brag-poster.jpg` — candidate poster image for the promo video.
- `assets/brag/brag-plan.md`, `assets/brag/share-copy.txt` — supporting notes
  from how the promo video was produced; useful context for captions/transcript
  copy, not required reading.

## Note on the plan's "existing repository" references

The plan was written assuming an existing CherryOnTop runtime checkout (with
`gui/`, `src/`, a root `package.json`, etc.) that the site is added onto. This
branch has none of that yet. Where the plan says "modify" a root file that
doesn't exist here (e.g. root `package.json`), create it fresh instead, scoped
to what the marketing site and backend actually need. Where the plan says not
to touch the Electron GUI or runtime daemon, there is nothing here to
accidentally touch — the constraint still matters for when this branch is
eventually merged alongside the runtime code, so keep `site/` and
`src/marketing/` isolated and additive exactly as specified.

## Developer workflow

```bash
npm ci && npm ci --prefix site     # root: marketing API; site/: React/Vite app

# Terminal 1 — marketing API (waitlist + analytics) on 127.0.0.1:4178
npm run marketing:api
# Terminal 2 — Vite dev server; proxies /api/* to the API above
npm run marketing:dev
```

One-command verification (typecheck, site unit tests, production build, API tests, Playwright):

```bash
npm run marketing:verify
```

Playwright needs its browsers once per machine (`npx --prefix site playwright install chromium`);
`npm run marketing:e2e` builds the site and serves it with the real API from
`site/e2e/fixtures/test-api.ts` on a temporary database.

Production: `npm run marketing:build && npm run marketing:start` serves the built site and
`/api/*` from one process. Operations: `npm run marketing:export -- <file.csv>`,
`npm run marketing:prune-telemetry -- <days>`.

## Documentation

- `docs/marketing/deployment.md` — same-origin serving, reverse proxy / trusted proxy, CSP and
  media origin, caching, smoke checks.
- `docs/marketing/operations.md` — DB backup, waitlist export, telemetry pruning, health,
  configuration rotation.
- `docs/marketing/content-policy.md` — model-agnostic, proprietary, product-first guardrails.
- `docs/marketing/analytics.md` — approved events, safe metadata, batching, retention, no-PII.
- `docs/marketing/benchmarks.md` — the controlled comparison behind the benchmark section
  (published with the site and linked from it).
