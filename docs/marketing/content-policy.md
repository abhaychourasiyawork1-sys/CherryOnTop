# CherryOnTop marketing site — content policy

Applies to every public string: `site/src/content.ts`, component copy, `site/index.html`
metadata, the promo transcript, alt text, and anything else shipped in `site/dist`.

## Positioning (locked)

- Headline: **AI teams you can hold accountable.** Eyebrow: **THE ACCOUNTABLE AI RUNTIME**.
- The page is a guided product exploration: show first → explain second → allow deeper
  inspection third. Product UI is the visual priority (80% product / 15% technical / 5% cinematic).

## Guardrails

1. **Model-agnostic.** Never name competitors, model providers or models in public copy.
2. **Proprietary.** Never describe or imply CherryOnTop is open source.
3. **Demo honesty.** The demo (`Build a customer support platform`, Frontend/Backend/Data/
   Verification, `47 / 47 checks`, `$2.31 / $5.00`, `VERIFIED`) is a deterministic,
   illustrative walkthrough. Never present it as a live customer workload or as measured data.
4. **No private reasoning.** Never display or imply access to model chain-of-thought.
5. **No fabricated proof.** No fake customer logos, testimonials, unsupported multipliers, or
   enterprise capabilities that have not shipped.
6. **Benchmarks carry scope.** Measured numbers appear only with their methodology
   (SWE-bench Verified · 6 tasks · 3 repetitions · 18 runs · controlled paired comparison) and
   limitations, and link to `docs/marketing/benchmarks.md` (published with the site at
   `/docs/marketing/benchmarks.md`). Any figure change must update that document first.
7. **Metadata uses product language only** — no "best", "fastest", or model-specific claims.

## Enforcement

- `site/test/content.test.ts` fails on forbidden strings in `SITE_CONTENT`, including
  `open source`.
- Launch audit grep over the built output (run after `npm run marketing:build`):
  ```bash
  grep -rlioE "open[- ]source|openai|anthropic|claude|gpt|gemini|llama|mistral|copilot|chatgpt|deepseek|grok" \
    site/dist/index.html site/dist/assets/*.js site/dist/media/*.txt
  ```
  Expected: no output. (Omit `cursor`/`devin` from greps over CSS — `cursor` is a CSS property.)
