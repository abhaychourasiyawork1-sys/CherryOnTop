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
