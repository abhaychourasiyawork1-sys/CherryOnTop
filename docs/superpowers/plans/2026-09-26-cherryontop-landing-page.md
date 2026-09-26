# CherryOnTop Landing Page Implementation Plan

> **Implementation status (2026-09-26):** Tasks 1–25 implemented. Verified in the build sandbox:
> root `typecheck` and `test` (marketing backend), site `typecheck`, site unit tests (incl.
> accessibility and SEO), and the production build. Task 23 (visual polish) was a code-level
> review against the locked visual grammar — no real-browser visual QA was possible. Task 24 audit
> fixed in-memory rate-limit key retention and dimmed-node text contrast. **Not verified:**
> `npm run marketing:e2e` (and therefore `marketing:verify`) — Playwright browsers cannot be
> installed in the sandbox; all 32 desktop/mobile specs fail at browser launch. Run it on a
> machine with Playwright browsers before launch, and complete the benchmark confirmation in
> `docs/marketing/operations.md`. The Electron GUI and runtime daemon are not in this repository,
> so their suites were not run here. Canonical copy of the plan: this file mirrors
> `docs/cherryontop-landing-page-plan.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the full CherryOnTop public landing page as a fast, model-agnostic, product-first React/Vite site with a deterministic interactive product story, integrated promo video, secure launch/waitlist backend, first-party interaction telemetry, responsive/mobile behavior, accessibility, SEO, performance controls, and production deployment wiring.

**Architecture:** Keep the public marketing surface separate from the Electron Mission Control GUI and from the localhost-only CherryOnTop daemon. Add a standalone `site/` React/Vite application for the browser experience and a standalone Fastify marketing service under `src/marketing/` for waitlist and telemetry APIs; in production the same marketing service may serve `site/dist` so browser traffic is same-origin (`/api/*`), while Vite proxies `/api/*` to the local marketing server during development. The marketing demo is a deterministic client-side state machine driven by one source of truth, not a live AI workload and not the runtime daemon.

**Tech Stack:** Node.js >=22, TypeScript, React 19, Vite, Fastify 5, Zod 4, Vitest 5, jsdom, Playwright for browser smoke/interaction tests, existing `better-sqlite3` for a dedicated marketing SQLite database, CSS custom properties, semantic HTML, native browser APIs for IntersectionObserver/`matchMedia`/`sendBeacon`, and the existing repository build/test conventions.

**Spec:** `/mnt/data/cherryontop-landing-page-spec.md` (source specification; when implemented in the repository, keep a copy or move it to `docs/cherryontop-landing-page-spec.md` and treat that tracked copy as the canonical implementation reference)

## Global Constraints

- **Primary positioning:** `AI teams you can hold accountable.`
- **Hero eyebrow:** `THE ACCOUNTABLE AI RUNTIME`
- **Hero body:** `Give autonomous AI work a goal, a mandate, a budget, and a way to prove the result.`
- **Primary CTA:** `Get CherryOnTop`
- **Secondary CTA:** `See how it works ↓`
- **Hero support line:** `Built for autonomous work that needs to get done—and checked.`
- **Experience mix:** **80% product-first**, **15% technical depth**, **5% cinematic polish**.
- The page is a **guided product exploration**, not a conventional feature list.
- **Never explain something before the visitor has had a chance to discover it visually.** Show first → explain second → allow deeper inspection third.
- Public copy is **model-agnostic**. Do not market the page using competitor, model-provider, or model names.
- CherryOnTop is **proprietary**. Do not describe or imply that it is open source.
- Do not imply the deterministic marketing demo is a live customer workload.
- Do not expose private model reasoning or chain-of-thought.
- Do not use fake customer logos, fabricated testimonials, unsupported performance multipliers, or enterprise capability claims that are not shipped.
- One recurring demo project is used throughout the page: **`Build a customer support platform`**.
- Demo responsibilities: **Frontend, Backend, Data, Verification**.
- Demo lifecycle: `Goal → Organize → Mandate → Execute → Recover → Validate → Verify → Receipt → Remember`.
- Demo completion display: `47 / 47 checks`, `$2.31 / $5.00`, `VERIFIED` as controlled illustrative values, clearly distinguishable from measured benchmark evidence.
- Core page sequence: `Navigation → Hero → Promo Video → Problem → Organization → Mandate → Execution → Failure → Recovery → Validation → Decision Receipt → Long-running Work + Memory → Measured Execution → Architecture → Trust → Final CTA → Footer`.
- Desktop layout: max content width approximately **1280–1360px**, **12-column grid**, navbar approximately **64–72px**, hero approximately **85–95vh**, major section spacing **120–180px**, subsection spacing **64–96px**, cards **24–32px**, large containers **20–24px radius**, cards **14–18px radius**, buttons **10–12px radius**, tiny controls approximately **8px radius**, low-contrast 1px borders, minimal shadows.
- Mobile transformation rule: **complex graph → vertical flow; hover → tap-to-expand; wide dashboard → stacked cards**.
- Responsive behavior: desktop explores the system spatially; mobile explores it sequentially.
- Three visual information layers: **Story → Product → Technical**. Deeper information is progressive disclosure, never required for basic comprehension.
- Visual system: dark-first, premium developer/infrastructure aesthetic; near-black/charcoal background, off-white text, muted gray, deep cherry/red accent, restrained verified/pass accent; no full-page red treatment.
- Typography: modern sans; desktop hero approximately **80–96px**, section headings **48–64px**, subheadings **24–32px**, body **18–20px**, product UI **13–15px**, technical metadata **11–12px monospace**.
- Motion rule: every animation must communicate a state or change, or reward exploration. Decorative motion without product meaning is excluded.
- The product UI is the visual priority. Marketing is built around product behavior.
- Normal browser scrolling; no scroll-jacking.
- Video: muted autoplay, play/pause, fullscreen, captions/transcript, poster image, lazy loading, and reduced-motion handling.
- The site must remain understandable with animation disabled and must have meaningful static fallbacks.
- Backend must be isolated from the CherryOnTop runtime daemon state database and must not reuse the Electron GUI transport for public traffic.
- Same-origin production wiring is preferred: browser → marketing Fastify → `/api/waitlist` and `/api/analytics` → dedicated marketing SQLite DB; static site served from `site/dist` by the same process or placed behind a reverse proxy with the same `/api` origin.
- Marketing API must not start Kubernetes jobs, call runtime adapters, access user repositories, or expose internal tRPC procedures.
- Launch/waitlist responses must not reveal whether an email already existed.
- Rate limiting must be applied to public POST endpoints; raw client IPs must not be persisted.
- Telemetry must not collect email addresses, repository paths, model/provider names, or free-form user content.
- Benchmark copy must use the documented controlled comparison: SWE-bench Verified, 6 tasks, 3 repetitions, 18 runs; measured run-level results are displayed only with methodology and scope.
- Existing CherryOnTop root requires Node.js >=22 and uses TypeScript/Vitest; the existing Electron GUI under `gui/` remains a separate desktop application.

## Review Focus

1. **Demo state desynchronization:** one source of truth must drive hero, organization, mandate, execution, failure/recovery, validation, and receipt states; pin this in Task 4 with reducer/state-machine tests and a Playwright transition smoke test.
2. **Scroll/interaction lifecycle bugs:** IntersectionObserver, timers, media observers, and listeners must be created/destroyed cleanly and must not duplicate when sections remount; pin this in Task 13 with reduced-motion and remount tests.
3. **Public API abuse and email privacy:** malformed input, duplicates, burst traffic, oversized payloads, honeypot submissions, and enumeration must produce safe non-revealing responses; pin this in Task 11 with API integration tests.
4. **Missing/blocked media:** if the promo video or poster is absent or fails to load, the page must remain coherent and the narrative must continue; pin this in Tasks 6 and 13 with asset-fallback tests.
5. **Responsive/deep-link regressions:** hash navigation, mobile menu focus, anchor scrolling, reduced-motion mode, and narrow layouts must remain operable; pin this in Task 13 with mobile Playwright smoke coverage.

---

## 1. Current Repository Integration Map

The implementation should be additive and deliberately avoid coupling the public site to the existing Electron renderer.

| Area | Existing baseline | Landing-page change |
|---|---|---|
| Runtime | `src/` TypeScript runtime, Fastify daemon, SQLite, tRPC | **Do not alter runtime behavior**; add isolated `src/marketing/` service |
| Desktop GUI | `gui/` Electron/Vite React app | **Do not replace or embed**; public site is a separate `site/` app |
| Build | root `package.json` has Node 22/typecheck/test/build scripts | Add `marketing:*` scripts that call the new site/server tasks |
| Server | `src/server/app.ts` binds daemon to localhost and serves internal tRPC | Leave it localhost/internal; do not expose it to the public website |
| DB | runtime SQLite under `src/db/` | Create a separate marketing DB file with only waitlist + telemetry tables |
| Docs | `docs/` contains architecture/strategy docs | Add tracked landing spec, plan, implementation/deployment docs |

### File map — create

```text
site/
  package.json
  package-lock.json
  tsconfig.json
  vite.config.ts
  index.html
  public/
    brand/
      cherry-mark.svg
      cherry-wordmark.svg
    media/
      cherryontop-promo.mp4
      cherryontop-promo-poster.webp
      cherryontop-promo-transcript.txt
    robots.txt
    sitemap.xml
  src/
    main.tsx
    App.tsx
    content.ts
    types.ts
    analytics/
      events.ts
      tracker.ts
    demo/
      types.ts
      data.ts
      state-machine.ts
      controller.tsx
    components/
      SiteHeader.tsx
      SiteFooter.tsx
      Section.tsx
      StatusIndicator.tsx
      ProductMetric.tsx
      ExecutionNode.tsx
      MandatePanel.tsx
      ExecutionTimeline.tsx
      RecoverySequence.tsx
      ValidationState.tsx
      DecisionReceipt.tsx
      MemoryTimeline.tsx
      BenchmarkEvidence.tsx
      ArchitectureExplorer.tsx
      PromoVideo.tsx
      LaunchForm.tsx
      Reveal.tsx
      DepthIndicator.tsx
    sections/
      HeroSection.tsx
      ProblemSection.tsx
      OrganizationSection.tsx
      MandateSection.tsx
      ExecutionSection.tsx
      AccountabilitySection.tsx
      LongRunningMemorySection.tsx
      BenchmarkSection.tsx
      ArchitectureSection.tsx
      TrustSection.tsx
      LaunchSection.tsx
    styles/
      tokens.css
      globals.css
      layout.css
      product-ui.css
      motion.css
      responsive.css
    test/
      setup.ts
      demo-state-machine.test.ts
      components.test.tsx
      navigation.test.tsx
      analytics.test.ts
      launch-form.test.tsx

src/marketing/
  app.ts
  config.ts
  db.ts
  rate-limit.ts
  schemas.ts
  waitlist.ts
  telemetry.ts
  app.test.ts
  waitlist.test.ts
  telemetry.test.ts

scripts/
  marketing-server.ts
  export-marketing-waitlist.mts

site/e2e/
  landing.spec.ts

site/e2e/fixtures/
  test-api.ts

docs/
  cherryontop-landing-page-spec.md
  marketing/
    deployment.md
    content-policy.md
    analytics.md
```

### File map — modify

```text
package.json
README.md
.gitignore
```

`package.json` gains root convenience scripts and any root-level dev dependencies needed by the marketing server/e2e tooling. `README.md` gains a short “Public marketing site” development/deployment entry without changing the runtime quickstart. `.gitignore` ignores local marketing DB files, local site build output if the project convention requires it, and local Playwright artifacts.

---

# 2. Task 1 — Create the site package and repository scripts

**Files:**
- Create: `site/package.json`
- Create: `site/tsconfig.json`
- Create: `site/vite.config.ts`
- Create: `site/index.html`
- Modify: `package.json`
- Modify: `.gitignore`
- Test: `site/test/setup.ts`

**Interfaces:**
- Consumes: existing root Node.js >=22 and TypeScript/Vitest conventions.
- Produces: a standalone `site` package with `dev`, `build`, `typecheck`, `test`, and `e2e` scripts; Vite proxy `/api` to `http://127.0.0.1:${MARKETING_PORT}` in development; production build output at `site/dist`.

- [ ] **Step 1: Write the failing package smoke check**

Create a minimal `site/test/setup.ts` and one test that imports the site root module and asserts the package can initialize under jsdom.

- [ ] **Step 2: Run the site test before scaffolding**

Run: `npm --prefix site test -- --run test/setup.ts`
Expected: FAIL because the site package/files do not yet exist.

- [ ] **Step 3: Implement the package scaffold**

Set the site package to Node >=22 and React 19, use Vite and TypeScript, and add Vitest/jsdom for unit/component tests. Add Playwright as a development dependency for browser smoke tests. Configure `vite.config.ts` so `/api` proxies to `MARKETING_API_URL` or `http://127.0.0.1:4178` in development. Keep the site independent from `gui/package.json`.

Add root scripts with these exact names:

```text
marketing:dev
marketing:api
marketing:build
marketing:test
marketing:e2e
marketing:typecheck
marketing:verify
```

`marketing:verify` should run the site typecheck, unit tests, build, marketing API tests, and e2e smoke suite in deterministic order.

- [ ] **Step 4: Implement the minimal semantic HTML shell**

`site/index.html` must include the document title, description, viewport, theme color, canonical URL placeholder, Open Graph/Twitter placeholders, and the root mount element. Do not inject the entire landing page as raw HTML; React owns content.

- [ ] **Step 5: Run tests and build**

Run:

```bash
npm --prefix site test
npm --prefix site run typecheck
npm --prefix site run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add site package.json .gitignore
git commit -m "feat: scaffold public marketing site"
```

---

# 3. Task 2 — Establish the brand/design token system and semantic shell

**Files:**
- Create: `site/src/styles/tokens.css`
- Create: `site/src/styles/globals.css`
- Create: `site/src/styles/layout.css`
- Create: `site/src/styles/product-ui.css`
- Create: `site/src/styles/motion.css`
- Create: `site/src/styles/responsive.css`
- Create: `site/src/types.ts`
- Create: `site/src/main.tsx`
- Create: `site/src/App.tsx`
- Create: `site/src/components/Section.tsx`
- Create: `site/src/components/Reveal.tsx`
- Test: `site/test/components.test.tsx`

**Interfaces:**
- `type Status = 'idle' | 'working' | 'waiting' | 'attention' | 'recovering' | 'validating' | 'verified'`.
- `function Section(props: { id: string; eyebrow?: string; title: string; body?: string; children: React.ReactNode }): JSX.Element`.
- `function Reveal(props: { children: React.ReactNode; once?: boolean; threshold?: number }): JSX.Element`.
- `function App(): JSX.Element` renders the site shell and sections in the locked information architecture order.

- [ ] **Step 1: Write failing design-system tests**

Test that rendering `StatusIndicator` later will expose textual state labels and that the root document contains one `h1`, landmark regions, and a `main` element. For this task specifically, assert the app shell has `header`, `main`, and `footer` placeholders and that `body` is not `overflow: hidden`.

- [ ] **Step 2: Run the tests and confirm the semantic shell fails**

Run: `npm --prefix site test -- components.test.tsx`
Expected: FAIL before implementation.

- [ ] **Step 3: Implement tokens**

Define centralized custom properties for background, panels, text levels, border, cherry accent, verified accent, spacing scale, radii, typography sizes, z-index layers, and motion durations. Use the spec values as ranges/guidance; exact pixel values should be chosen centrally, not scattered across components.

Define the core visual rule in comments: the cherry accent is a signal, not a dominant page color.

- [ ] **Step 4: Implement semantic global/layout CSS**

Use a 12-column desktop grid, max-width container approximately 1280–1360px, 24–32px page padding, and section spacing from the spec. Set `html { scroll-behavior: smooth; }` only when reduced motion is not requested; the reduced-motion branch must remove animated scroll behavior.

Use semantic sans typography and reserve monospace for figures/technical metadata.

- [ ] **Step 5: Implement the `Section` and `Reveal` primitives**

`Reveal` should use `IntersectionObserver` when available, reveal once by default, disconnect on unmount, and expose a static visible state when `prefers-reduced-motion: reduce` is active. It must not be required for comprehension.

- [ ] **Step 6: Implement `App.tsx` with section placeholders**

Render all major sections in the locked order, with temporary placeholder headings matching the approved section names. Keep all anchors stable from the start:

```text
#product
#how-it-works
#organization
#mandate
#execution
#proof
#memory
#benchmarks
#architecture
#trust
#launch
```

- [ ] **Step 7: Run tests/typecheck**

Run:

```bash
npm --prefix site test
npm --prefix site run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add site/src/styles site/src/main.tsx site/src/App.tsx site/src/types.ts site/src/components/Section.tsx site/src/components/Reveal.tsx site/test/components.test.tsx
git commit -m "feat: add landing design system and semantic shell"
```

---

# 4. Task 3 — Add brand assets and all approved content as structured data

**Files:**
- Create: `site/public/brand/cherry-mark.svg`
- Create: `site/public/brand/cherry-wordmark.svg`
- Create: `site/src/content.ts`
- Create: `docs/cherryontop-landing-page-spec.md` (copy the approved spec into the repository)
- Test: `site/test/content.test.ts`

**Interfaces:**
- `export const SITE_CONTENT: SiteContent`.
- `type SiteContent = { nav: ...; hero: ...; problem: ...; organization: ...; mandate: ...; execution: ...; receipt: ...; memory: ...; benchmarks: ...; architecture: ...; trust: ...; launch: ... }`.

- [ ] **Step 1: Write failing content tests**

Assert the locked hero strings exist exactly, the customer-support-platform scenario is present, and forbidden marketing strings are absent from public content (competitor/model names, `open source`, unsupported multiplier language).

- [ ] **Step 2: Run the tests**

Run: `npm --prefix site test -- content.test.ts`
Expected: FAIL before content data is added.

- [ ] **Step 3: Implement the vector brand mark**

Create a minimal premium cherry SVG inspired by the approved real-cherry reference: organic silhouette, no face, no childish mascot, distinctive curved stem. The stem/branch geometry must be reusable as a CSS/SVG motif later. Do not use emoji as the production logo.

- [ ] **Step 4: Implement structured content**

Store all approved copy in `site/src/content.ts` rather than repeating strings throughout components. Include:

- Hero: `THE ACCOUNTABLE AI RUNTIME`, `AI teams you can hold accountable.`, the exact body/CTA/support line.
- Problem: `AI can do the work. But who controls it?` and the three questions.
- Organization: `One goal. An accountable AI organization.` and its supporting text.
- Mandate: `Autonomy without a blank cheque.` and the authority copy.
- Execution: `Real work doesn't always go perfectly.` and the recovery/validation copy.
- Receipt: `Every important decision leaves a receipt.` and receipt labels.
- Long-running: `Work that keeps going.`
- Memory: `The organization remembers what it learned.`
- Performance: `Spend intelligence where it matters.`
- Architecture: `Under the interface is a real execution system.`
- Trust: `Built to be inspected.`
- Final CTA: launch-soon copy and form labels.

Include benchmark methodology text as scope-specific evidence, not a universal performance promise.

- [ ] **Step 5: Run the content test**

Run: `npm --prefix site test -- content.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add site/public/brand site/src/content.ts site/test/content.test.ts docs/cherryontop-landing-page-spec.md
git commit -m "feat: add CherryOnTop marketing content and brand assets"
```

---

# 5. Task 4 — Build the deterministic product-demo state machine

**Files:**
- Create: `site/src/demo/types.ts`
- Create: `site/src/demo/data.ts`
- Create: `site/src/demo/state-machine.ts`
- Create: `site/src/demo/controller.tsx`
- Create: `site/test/demo-state-machine.test.ts`

**Interfaces:**
- `type DemoState = 'goal' | 'organization' | 'mandate' | 'executing' | 'failure' | 'recovering' | 'validating' | 'verified' | 'receipt' | 'memory'`.
- `type DemoNodeId = 'frontend' | 'backend' | 'data' | 'verification'`.
- `interface DemoSnapshot { state: DemoState; activeNodeId: DemoNodeId | null; counters: { filesRead: number; filesChanged: number; commands: number; checks: number; checksPassed: number; artifacts: number; spend: number; budget: number }; approvalRequired: boolean; receiptVisible: boolean; memoryRun: 1 | 2 | null }`.
- `function transition(snapshot: DemoSnapshot, event: DemoEvent): DemoSnapshot`.
- `type DemoEvent = { type: 'NEXT' } | { type: 'RESET' } | { type: 'INSPECT_NODE'; nodeId: DemoNodeId } | { type: 'CLOSE_INSPECTOR' } | { type: 'REPLAY' }`.
- `function createInitialSnapshot(): DemoSnapshot`.
- `DemoControllerProvider` exposes `{ snapshot, dispatch, reducedMotion, replay }` through React context.

- [ ] **Step 1: Write failing transition tests**

Cover the exact sequence:

```text
goal → organization → mandate → executing → failure → recovering → validating → verified → receipt
```

Assert that no transition skips failure/recovery, that `receiptVisible` is false before `verified`, and that the final verified snapshot contains the illustrative values `47/47` and `$2.31/$5.00`.

Also test node inspection never mutates the lifecycle state.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm --prefix site test -- demo-state-machine.test.ts`
Expected: FAIL before implementation.

- [ ] **Step 3: Implement demo data**

Define the recurring customer-support-platform scenario and the exact illustrative event timeline. Keep data separate from transition logic so later visual refinements do not alter behavior.

- [ ] **Step 4: Implement pure transitions**

Make `transition()` a pure function. It must be deterministic and side-effect free. The controller is responsible for timing/animation; the state machine is only the truth source.

- [ ] **Step 5: Implement the React controller**

The controller should expose the snapshot and dispatch function to the visual components. It must support `REPLAY` and `RESET` without leaking timers.

- [ ] **Step 6: Add deterministic playback timing**

Create a single timing configuration object in `controller.tsx` (goal, organization, mandate, execution, failure pause, recovery, validation, receipt) rather than hardcoding timers throughout components. Reduced motion switches to state transitions with no animation delay.

- [ ] **Step 7: Run unit tests and typecheck**

Run:

```bash
npm --prefix site test -- demo-state-machine.test.ts
npm --prefix site run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add site/src/demo site/test/demo-state-machine.test.ts
git commit -m "feat: add deterministic product demo state machine"
```

---

# 6. Task 5 — Implement product UI primitives and the shared visual state system

**Files:**
- Create: `site/src/components/StatusIndicator.tsx`
- Create: `site/src/components/ProductMetric.tsx`
- Create: `site/src/components/ExecutionNode.tsx`
- Create: `site/src/components/MandatePanel.tsx`
- Create: `site/src/components/ValidationState.tsx`
- Modify: `site/src/styles/product-ui.css`
- Test: `site/test/components.test.tsx`

**Interfaces:**
- `function StatusIndicator(props: { status: Status; label?: string }): JSX.Element`.
- `function ProductMetric(props: { label: string; value: string; mono?: boolean }): JSX.Element`.
- `function ExecutionNode(props: { id: DemoNodeId; title: string; role: string; status: Status; budget: string; selected?: boolean; onInspect: () => void }): JSX.Element`.
- `function MandatePanel(props: { action: string; currentAuthority: string; requiredAuthority: string; approved: boolean; onReview: () => void }): JSX.Element`.
- `function ValidationState(props: { passed: number; total: number; state: 'running' | 'failed' | 'verified' }): JSX.Element`.

- [ ] **Step 1: Write failing component tests**

Assert accessible labels and exact state semantics: `Working`, `Waiting`, `Needs attention`, `Recovering`, `Validating`, `Verified`. Verify status is represented by text/icon and not by color alone.

- [ ] **Step 2: Run tests**

Run: `npm --prefix site test -- components.test.tsx`
Expected: FAIL until primitives exist.

- [ ] **Step 3: Implement shared primitives**

Keep components product-like rather than marketing-card-like. Use subtle borders, minimal shadows, and status as a consistent visual vocabulary. Neighboring node dimming must be handled by the parent explorer, not by `ExecutionNode` itself.

- [ ] **Step 4: Implement keyboard/touch interaction contracts**

Interactive nodes are buttons with accessible names. Hover effects are supplementary. Mobile interaction must work with tap/click only.

- [ ] **Step 5: Run tests and verify**

Run: `npm --prefix site test -- components.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add site/src/components site/src/styles/product-ui.css site/test/components.test.tsx
git commit -m "feat: add shared product UI primitives"
```

---

# 7. Task 6 — Implement the hero and promo video experience

**Files:**
- Create: `site/src/sections/HeroSection.tsx`
- Create: `site/src/components/PromoVideo.tsx`
- Modify: `site/src/App.tsx`
- Modify: `site/src/styles/layout.css`
- Modify: `site/src/styles/motion.css`
- Create: `site/test/hero-video.test.tsx`
- Assets: `site/public/media/cherryontop-promo.mp4`, `cherryontop-promo-poster.webp`, `cherryontop-promo-transcript.txt`

**Interfaces:**
- `function HeroSection(): JSX.Element`.
- `function PromoVideo(props: { src: string; poster: string; transcript: string; title: string }): JSX.Element`.

- [ ] **Step 1: Write failing hero/video tests**

Assert the exact hero copy, two CTA actions, a visible product-demo region, and a video with `muted`, `playsInline`, controls, poster, accessible label, and a transcript link/container.

- [ ] **Step 2: Run tests**

Run: `npm --prefix site test -- hero-video.test.tsx`
Expected: FAIL before implementation.

- [ ] **Step 3: Implement the hero**

Desktop hero occupies approximately 85–95vh but must leave a visual hint of the next section. The headline is the primary text block; the product UI is the primary visual. Do not put benchmark stats in the hero.

- [ ] **Step 4: Wire the hero to `DemoControllerProvider`**

The hero demo must play the same deterministic lifecycle used later by the page. The first reveal is `goal → organization`, not an unrelated hero-only animation.

- [ ] **Step 5: Implement `PromoVideo`**

Use a `<video>` element with muted autoplay, `playsInline`, controls, poster, captions or an adjacent transcript, and a poster fallback. Do not autoplay sound. If the asset is missing or errors, retain the poster and a “Watch the demonstration” transcript/open state so the story remains coherent.

- [ ] **Step 6: Add the Hyperframe asset**

Place the final generated video at `site/public/media/cherryontop-promo.mp4`. If the final file is hosted elsewhere, make the source configurable using `VITE_PROMO_VIDEO_URL`, but keep the local poster/transcript fallback.

- [ ] **Step 7: Run tests/build**

Run:

```bash
npm --prefix site test -- hero-video.test.tsx
npm --prefix site run build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add site/src/sections/HeroSection.tsx site/src/components/PromoVideo.tsx site/src/App.tsx site/src/styles site/public/media site/test/hero-video.test.tsx
git commit -m "feat: add hero and product introduction video"
```

---

# 8. Task 7 — Implement problem and organization exploration

**Files:**
- Create: `site/src/sections/ProblemSection.tsx`
- Create: `site/src/sections/OrganizationSection.tsx`
- Modify: `site/src/components/ExecutionNode.tsx`
- Modify: `site/src/demo/controller.tsx`
- Test: `site/test/organization.test.tsx`

**Interfaces:**
- `function ProblemSection(): JSX.Element`.
- `function OrganizationSection(): JSX.Element`.
- `OrganizationSection` consumes `DemoSnapshot` and `dispatch` from `DemoControllerProvider`.

- [ ] **Step 1: Write failing organization tests**

Assert initial state shows one goal, then the organization nodes appear in the deterministic order `Frontend`, `Backend`, `Verification`, with optional `Data` available only in deeper state. Assert inspecting a node does not alter lifecycle state.

- [ ] **Step 2: Run tests**

Run: `npm --prefix site test -- organization.test.tsx`
Expected: FAIL before implementation.

- [ ] **Step 3: Implement the problem section**

Use the approved three-question framing with a quieter visual treatment. Keep semantic headings and explanatory text in the DOM even when visual reveals are active.

- [ ] **Step 4: Implement the organization diagram**

Desktop: one goal branches into specialized responsibilities. The same stem/branch geometry becomes the connective visual motif. Avoid browser-window framing. Product UI should feel integrated into the page.

- [ ] **Step 5: Implement node inspection**

Hover on desktop reveals additional details; click always works. Mobile uses tap-to-expand. Inspection reveals role, authority, budget, and actions; neighboring nodes become slightly quieter while inspected.

- [ ] **Step 6: Implement the first signature wow moment**

The single goal progressively becomes an organization. No random graph animation. The branch drawing and node entrance are controlled by demo state.

- [ ] **Step 7: Run tests and typecheck**

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add site/src/sections/ProblemSection.tsx site/src/sections/OrganizationSection.tsx site/src/components/ExecutionNode.tsx site/src/demo/controller.tsx site/test/organization.test.tsx
git commit -m "feat: add problem and organization exploration"
```

---

# 9. Task 8 — Implement mandate boundary and approval interaction

**Files:**
- Create: `site/src/sections/MandateSection.tsx`
- Create: `site/src/components/DepthIndicator.tsx`
- Modify: `site/src/components/MandatePanel.tsx`
- Test: `site/test/mandate.test.tsx`

**Interfaces:**
- `function MandateSection(): JSX.Element`.
- `function DepthIndicator(props: { level: 'story' | 'product' | 'technical' }): JSX.Element`.
- `MandatePanel` receives the current/required authority and emits `onReview` without any backend call.

- [ ] **Step 1: Write failing mandate tests**

Assert the action `Deploy database migration` is blocked, `Current authority: Development`, `Required authority: Deployment`, and `Human approval required` are visible. Assert clicking review reveals the authority explanation but does not open a real backend approval request.

- [ ] **Step 2: Run tests**

Run: `npm --prefix site test -- mandate.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement mandate copy and visual state**

Use the exact approved section copy. Keep the refusal calm: no flashing red alert, no aggressive animation.

- [ ] **Step 4: Implement progressive disclosure**

Default view: simple authority result. Expanded view: why the action is blocked. Keep technical metadata smaller than the story copy.

- [ ] **Step 5: Implement signature wow moment #2**

The system visibly says “No” to the out-of-authority action, then transitions to `Permission is only half the problem.` and the next proof section.

- [ ] **Step 6: Run tests/typecheck**

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add site/src/sections/MandateSection.tsx site/src/components/MandatePanel.tsx site/src/components/DepthIndicator.tsx site/test/mandate.test.tsx
git commit -m "feat: add mandate and authority boundary demo"
```

---

# 10. Task 9 — Implement execution, failure, recovery, and validation as one continuous sequence

**Files:**
- Create: `site/src/sections/ExecutionSection.tsx`
- Create: `site/src/components/ExecutionTimeline.tsx`
- Create: `site/src/components/RecoverySequence.tsx`
- Create: `site/src/components/ValidationState.tsx`
- Modify: `site/src/demo/data.ts`
- Test: `site/test/execution.test.tsx`

**Interfaces:**
- `function ExecutionSection(): JSX.Element`.
- `function ExecutionTimeline(props: { events: DemoTimelineEvent[]; activeIndex: number }): JSX.Element`.
- `function RecoverySequence(props: { state: 'failed' | 'recovering' | 'verified' }): JSX.Element`.
- `function ValidationState(props: { passed: number; total: number; state: 'running' | 'failed' | 'verified' }): JSX.Element`.
- `type DemoTimelineEvent = { id: string; time: string; label: string; detail?: string }`.

- [ ] **Step 1: Write failing execution tests**

Assert the timeline contains the approved concrete signals (`18 files read`, `12 files changed`, `31 commands`) and the lifecycle preserves the visible failure before recovery. Assert `38 / 47` appears before `47 / 47`.

- [ ] **Step 2: Run tests**

Run: `npm --prefix site test -- execution.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the execution timeline**

Desktop: compact event stream with time metadata. Mobile: vertical timeline. The timeline is driven by the demo state, not independent component timers.

- [ ] **Step 4: Implement failure pause**

At `failure`, stop motion briefly. Show:

`Verification failed`

and:

`The system doesn't pretend it didn't.`

Do not erase prior events.

- [ ] **Step 5: Implement recovery sequence**

Show `Investigating → Affected component → Correction → Re-validation`, then hand back to the validation state.

- [ ] **Step 6: Implement validation payoff**

Show `47 / 47 checks passed` and `VERIFIED`. Use the same verified treatment everywhere on the page. The completed state must visually become calmer and clearer.

- [ ] **Step 7: Run tests**

Run: `npm --prefix site test -- execution.test.tsx`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add site/src/sections/ExecutionSection.tsx site/src/components/ExecutionTimeline.tsx site/src/components/RecoverySequence.tsx site/src/components/ValidationState.tsx site/src/demo/data.ts site/test/execution.test.tsx
git commit -m "feat: add execution recovery and validation story"
```

---

# 11. Task 10 — Implement accountability receipt, long-running work, and memory

**Files:**
- Create: `site/src/sections/AccountabilitySection.tsx`
- Create: `site/src/components/DecisionReceipt.tsx`
- Create: `site/src/sections/LongRunningMemorySection.tsx`
- Create: `site/src/components/MemoryTimeline.tsx`
- Test: `site/test/receipt-memory.test.tsx`

**Interfaces:**
- `interface ReceiptViewModel { objective: string; decision: string; authority: string; budget: string; spend: string; actions: string; artifacts: string; validation: string; humanIntervention: string; outcome: 'VERIFIED' }`.
- `function DecisionReceipt(props: { receipt: ReceiptViewModel; expanded?: boolean; onToggle: () => void }): JSX.Element`.
- `function MemoryTimeline(props: { runs: MemoryRun[] }): JSX.Element`.
- `interface MemoryRun { id: string; title: string; steps: string[]; validated: string[] }`.

- [ ] **Step 1: Write failing receipt/memory tests**

Assert the receipt contains the locked fields and values:

```text
OBJECTIVE: Build customer platform
AUTHORITY: Development mandate
BUDGET: $5.00 authorized
SPEND: $2.31 used
ACTIONS: 12 files changed · 31 commands executed
ARTIFACTS: 17 produced
VALIDATION: 47 checks passed
HUMAN INTERVENTION: 1 approval
OUTCOME: VERIFIED
```

Assert that the receipt does not contain transcript text or chain-of-thought.

Assert memory shows `RUN 01 → Observed → Validated → Remembered → RUN 02 → Reused` and distinguishes asserted vs validated knowledge.

- [ ] **Step 2: Run tests**

Run: `npm --prefix site test -- receipt-memory.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the receipt**

Use a product-like artifact, not legal/compliance paperwork. Default view is scannable; clicking/keyboard expanding reveals more detail. Complexity from prior sections visually compresses into the receipt to create signature wow moment #4.

- [ ] **Step 4: Implement long-running work sequence**

Show `Goal received → Organization formed → Execution → Issue discovered → Recovery → Validation → Verified` with statuses such as `Working`, `Waiting`, `Needs attention`, `Recovering`, `Verified`. Show budget awareness such as `$2.84 / $5` only as controlled illustrative UI.

- [ ] **Step 5: Implement memory sequence**

Show first-run discovery and validation, then a second run reusing verified information. Use `Reuse what the organization has already verified.` Do not use “self-learning” claims.

- [ ] **Step 6: Run tests/typecheck**

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add site/src/sections/AccountabilitySection.tsx site/src/components/DecisionReceipt.tsx site/src/sections/LongRunningMemorySection.tsx site/src/components/MemoryTimeline.tsx site/test/receipt-memory.test.tsx
git commit -m "feat: add proof receipt and memory story"
```

---

# 12. Task 11 — Implement measured execution, architecture explorer, trust, navigation, footer, and final CTA shell

**Files:**
- Create: `site/src/sections/BenchmarkSection.tsx`
- Create: `site/src/components/BenchmarkEvidence.tsx`
- Create: `docs/marketing/benchmarks.md`
- Create: `site/src/sections/ArchitectureSection.tsx`
- Create: `site/src/components/ArchitectureExplorer.tsx`
- Create: `site/src/sections/TrustSection.tsx`
- Create: `site/src/components/SiteHeader.tsx`
- Create: `site/src/components/SiteFooter.tsx`
- Create: `site/src/sections/LaunchSection.tsx`
- Create: `site/src/components/LaunchForm.tsx`
- Test: `site/test/navigation.test.tsx`

**Interfaces:**
- `function BenchmarkEvidence(): JSX.Element` renders scope-qualified benchmark evidence.
- `function ArchitectureExplorer(props: { layers: ArchitectureLayer[] }): JSX.Element`.
- `interface ArchitectureLayer { id: string; title: string; summary: string; children: { title: string; details: string }[] }`.
- `function SiteHeader(): JSX.Element`.
- `function SiteFooter(): JSX.Element`.
- `function LaunchForm(props: { onSuccess?: () => void }): JSX.Element`.

- [ ] **Step 1: Write failing navigation/section tests**

Assert all nav labels exist exactly:

`Product`, `How it works`, `Architecture`, `Benchmarks`, `Documentation`, `Get CherryOnTop`.

Assert anchors exist and the final CTA is reachable from every primary CTA.

Assert footer contains product/resources/company/legal groups without generic SaaS link sprawl.

- [ ] **Step 2: Run tests**

Run: `npm --prefix site test -- navigation.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement benchmark evidence**

Display measured benchmark scope:

- `18 / 18 resolved`
- approximately `15% lower mean cost/run`
- approximately `15% fewer mean tokens/run`
- `SWE-bench Verified · 6 tasks · 3 repetitions · controlled paired comparison`

The implementation must also include the methodology/limitations text: this is one controlled benchmark and should not be generalized into a universal guarantee. Link to `docs/marketing/benchmarks.md`, which contains the scoped benchmark summary, methodology, paired comparison, and limitations.

- [ ] **Step 4: Implement architecture explorer**

Default:

```text
YOUR GOAL
↓
CONTROL PLANE
↓
EXECUTION
↓
VALIDATION
↓
PROOF
```

Clicking `CONTROL PLANE` reveals `Context`, `Decision`, `Policy`, `State`, `Budget`. Clicking `PROOF` reveals `Evidence`, `Artifacts`, `Validation`, `Decision Receipt`. Keep deeper technical detail behind explicit interaction.

- [ ] **Step 5: Implement trust section**

Use `Built to be inspected.` and real evidence links: product, benchmarks, architecture, documentation, security. Do not add fake social proof. Include a real limitations link/section if a documented limitations page exists.

- [ ] **Step 6: Implement site header/footer**

Header at top is transparent/integrated; on scroll it gains a subtle dark surface and border. Mobile collapses to logo + menu. Mobile menu must trap focus only while open, return focus to trigger on close, and close on link selection.

- [ ] **Step 7: Implement final CTA shell**

Show:

`CherryOnTop is launching soon.`

`Be among the first to get access.`

Email input + `Join the launch`.

Success:

`You're on the list.`

`We'll let you know when CherryOnTop is ready.`

Do not hardcode pricing.

- [ ] **Step 8: Run tests**

Run: `npm --prefix site test -- navigation.test.tsx`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add site/src/sections/BenchmarkSection.tsx site/src/components/BenchmarkEvidence.tsx site/src/sections/ArchitectureSection.tsx site/src/components/ArchitectureExplorer.tsx site/src/sections/TrustSection.tsx site/src/components/SiteHeader.tsx site/src/components/SiteFooter.tsx site/src/sections/LaunchSection.tsx site/src/components/LaunchForm.tsx site/test/navigation.test.tsx
git commit -m "feat: add architecture benchmarks navigation and launch CTA"
```

---

# 13. Task 12 — Implement the marketing backend: dedicated SQLite store, waitlist API, and safe public error handling

**Files:**
- Create: `src/marketing/config.ts`
- Create: `src/marketing/db.ts`
- Create: `src/marketing/schemas.ts`
- Create: `src/marketing/waitlist.ts`
- Create: `src/marketing/rate-limit.ts`
- Create: `src/marketing/app.ts`
- Create: `src/marketing/waitlist.test.ts`
- Create: `src/marketing/app.test.ts`
- Create: `scripts/marketing-server.ts`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- `interface MarketingConfig { port: number; host: string; dbPath: string; siteDir: string; allowedOrigin?: string; trustProxy: boolean; consentVersion?: string; }`.
- `function loadMarketingConfig(env: NodeJS.ProcessEnv): MarketingConfig`.
- `function createMarketingDb(path: string): MarketingDb`.
- `interface WaitlistInput { email: string; intent?: 'Software development' | 'Research' | 'Automation' | 'Operations' | 'Other'; honeypot?: string; consentVersion?: string | null; }`.
- `interface WaitlistResult { accepted: true }`.
- `function addToWaitlist(input: WaitlistInput): WaitlistResult`.
- `function buildMarketingApp(config?: Partial<MarketingConfig>): FastifyInstance`.

### Data model

The marketing DB is intentionally separate from the runtime DB.

`waitlist_signups`:

```text
id TEXT PRIMARY KEY
email TEXT NOT NULL UNIQUE
intent TEXT NULL
consent_version TEXT NULL
created_at TEXT NOT NULL
```

`marketing_events`:

```text
id INTEGER PRIMARY KEY AUTOINCREMENT
event TEXT NOT NULL
session_id TEXT NOT NULL
path TEXT NOT NULL
metadata TEXT NOT NULL
created_at TEXT NOT NULL
```

Do not store raw IPs. Do not store repository paths. Do not store free-form email in telemetry.

- [ ] **Step 1: Write failing API tests**

Cover:

1. valid email returns success;
2. whitespace/case is normalized;
3. duplicate email returns the same success shape as a first submission;
4. invalid email returns a 400 without sensitive details;
5. oversized body is rejected;
6. honeypot-filled request is accepted into the same generic success response but does not create a row;
7. burst traffic over the configured limit returns 429;
8. waitlist persistence survives reopening the SQLite database;
9. public API does not expose internal runtime/tRPC routes;
10. API errors never include raw SQL/error strings.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/marketing/waitlist.test.ts src/marketing/app.test.ts`
Expected: FAIL before implementation.

- [ ] **Step 3: Implement marketing configuration**

Use:

```text
MARKETING_PORT=4178
MARKETING_HOST=127.0.0.1 (dev; 0.0.0.0 in production container)
MARKETING_DB_PATH=~/.cherryontop/marketing.db
MARKETING_SITE_DIR=site/dist
MARKETING_ALLOWED_ORIGIN=optional
MARKETING_TRUST_PROXY=false by default
MARKETING_CONSENT_VERSION=optional
```

Do not reuse `ORG_DAEMON_PORT` or `ORG_DB_PATH`.

- [ ] **Step 4: Implement isolated SQLite initialization**

Create tables on startup with `CREATE TABLE IF NOT EXISTS`, enable WAL mode, enforce foreign keys if later used, and add the email uniqueness constraint. Do not import `src/db/schema.ts` into the marketing service.

- [ ] **Step 5: Implement input schema and normalization**

Normalize email using trim + lowercase and validate with Zod. Limit intent to the exact five allowed values. If `MARKETING_CONSENT_VERSION` is configured, require the matching consent version; otherwise store `null` and omit a checkbox from the UI.

- [ ] **Step 6: Implement in-memory rate limiting**

Use a small process-local limiter keyed by `request.ip` with a fixed window sufficient to protect the endpoint. Do not persist the key. Configure Fastify `trustProxy` only when a trusted reverse proxy is actually in front of the service.

- [ ] **Step 7: Implement the waitlist service**

Use an insert-or-ignore strategy so duplicate submissions are idempotent and do not permit account/email enumeration. Return a generic accepted response for both new and duplicate emails.

- [ ] **Step 8: Implement Fastify routes**

`POST /api/waitlist`

- JSON body only.
- 20 KB max request payload.
- `Content-Type: application/json` required.
- generic success response.
- validation failures as `400`.
- rate limit as `429`.

`GET /api/health`

- Return service health without DB path or filesystem details.

- [ ] **Step 9: Add hardened production headers at the marketing app layer**

Set `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, a restrictive `Permissions-Policy`, and a CSP that allows only the known media/font/API origins. Keep CSP explicit and configurable for the final video host.

- [ ] **Step 10: Run backend tests/typecheck**

Run:

```bash
npm test -- src/marketing/waitlist.test.ts src/marketing/app.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/marketing scripts/marketing-server.ts package.json .gitignore
git commit -m "feat: add secure marketing waitlist backend"
```

---

# 14. Task 13 — Wire the launch form to the backend

**Files:**
- Modify: `site/src/components/LaunchForm.tsx`
- Create: `site/test/launch-form.test.tsx`
- Modify: `site/src/content.ts`

**Interfaces:**
- `async function submitWaitlist(input: { email: string; intent?: string; honeypot?: string; consentVersion?: string | null }): Promise<WaitlistResult>` calls `POST /api/waitlist`.
- `LaunchForm` states: `idle | submitting | success | error`.

- [ ] **Step 1: Write failing client-form tests**

Cover:

1. empty/invalid email blocks submission locally;
2. submit disables the button while pending;
3. successful 202/200 response shows the exact success copy;
4. 429 shows a retry-safe message without exposing server details;
5. network failure preserves the entered email and shows a generic error;
6. duplicate response still shows the same success state;
7. configured consent version renders a checkbox and sends it; absent configuration renders no checkbox.

- [ ] **Step 2: Run tests**

Run: `npm --prefix site test -- launch-form.test.tsx`
Expected: FAIL before wiring.

- [ ] **Step 3: Implement `submitWaitlist()`**

Use same-origin `/api/waitlist` in production. Do not hardcode a production domain. Let Vite proxy this path in development.

- [ ] **Step 4: Implement the form state machine**

Keep UI states explicit. Do not show a fake success if the network request fails. On success, clear only the email field if desired; do not force a page reload or navigate away.

- [ ] **Step 5: Add optional intent selector**

Use exact choices: `Software development`, `Research`, `Automation`, `Operations`, `Other`. Keep it secondary to email entry so the CTA remains visually simple.

- [ ] **Step 6: Run tests**

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add site/src/components/LaunchForm.tsx site/test/launch-form.test.tsx site/src/content.ts
git commit -m "feat: connect launch form to waitlist API"
```

---

# 15. Task 14 — Implement first-party analytics/interaction telemetry

**Files:**
- Create: `site/src/analytics/events.ts`
- Create: `site/src/analytics/tracker.ts`
- Create: `src/marketing/telemetry.ts`
- Create: `src/marketing/telemetry.test.ts`
- Modify: `src/marketing/app.ts`
- Create: `site/test/analytics.test.ts`
- Modify: `site/src/App.tsx`

**Interfaces:**
- `type AnalyticsEventName = 'hero_cta_clicked' | 'video_started' | 'organization_explored' | 'mandate_explored' | 'receipt_opened' | 'architecture_explored' | 'benchmark_viewed' | 'launch_form_started' | 'launch_form_submitted'`.
- `function track(event: AnalyticsEventName, metadata?: Record<string, string | number | boolean>): void`.
- `function flush(): Promise<void>`.
- `function createTelemetryStore(...): TelemetryStore`.

- [ ] **Step 1: Write failing analytics tests**

Assert that only the approved event names are accepted, free-form strings are rejected, payloads have bounded size, and no email/repository/model fields are accepted. Assert batching and flush behavior.

- [ ] **Step 2: Implement client tracker**

Use an in-memory session ID generated once per tab. Prefer `navigator.sendBeacon()` on page hide and `fetch(..., { keepalive: true })` elsewhere. Batch a small number of events to minimize requests.

- [ ] **Step 3: Wire events to real interactions**

Emit:

- `hero_cta_clicked` on the primary CTA.
- `video_started` on first media play.
- `organization_explored` when a node is inspected.
- `mandate_explored` when the authority detail opens.
- `receipt_opened` when receipt detail is expanded.
- `architecture_explored` when a technical layer is expanded.
- `benchmark_viewed` once when the benchmark section enters the viewport.
- `launch_form_started` when the form receives first focus/input.
- `launch_form_submitted` only after a successful server response.

- [ ] **Step 4: Write failing server telemetry tests**

Cover malformed events, oversized batches, unknown event names, no PII fields, and persistence.

- [ ] **Step 5: Implement `POST /api/analytics`**

Accept a bounded batch such as 1–20 events per request. Persist only event name, session ID, path, safe metadata, and timestamp. Do not store user-agent or raw IP unless a later privacy review explicitly approves it.

- [ ] **Step 6: Add basic retention hook**

Create a small maintenance function for deleting telemetry older than a configurable retention period. The default may be documented as a short operational retention window; the actual production value must be explicitly set in deployment configuration rather than silently inferred.

- [ ] **Step 7: Run tests**

Run:

```bash
npm --prefix site test -- analytics.test.ts
npm test -- src/marketing/telemetry.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add site/src/analytics site/test/analytics.test.ts site/src/App.tsx src/marketing/telemetry.ts src/marketing/telemetry.test.ts src/marketing/app.ts
git commit -m "feat: add privacy-bounded marketing telemetry"
```

---

# 16. Task 15 — Wire the complete page composition and progressive disclosure

**Files:**
- Modify: `site/src/App.tsx`
- Modify: all `site/src/sections/*.tsx`
- Modify: `site/src/components/DepthIndicator.tsx`
- Modify: `site/src/demo/controller.tsx`
- Test: `site/test/components.test.tsx`

**Interfaces:**
- `App` owns one `DemoControllerProvider` spanning all sections that participate in the shared demo narrative.
- Each section consumes the controller but does not create competing lifecycle state.

- [ ] **Step 1: Write a composition test**

Render the full app and assert the main headings appear in the approved order.

- [ ] **Step 2: Implement the full composition**

Use one provider around the complete product story. Do not mount separate demo state machines per section.

- [ ] **Step 3: Add the three visual depth levels**

The side/depth indicator should evolve quietly from Story → Product → Technical as the user reaches deeper sections. Do not make this a progress bar.

- [ ] **Step 4: Add product-first quiet/dense rhythm**

Use visual density intentionally:

```text
Hero — sparse/dramatic
Organization — dense/interactive
Mandate — precise/focused
Execution — active
Failure — still
Recovery — active again
Validation — clean/payoff
Receipt — information-rich
Memory — quiet
Benchmark — analytical
Architecture — technical
CTA — quiet
```

- [ ] **Step 5: Implement evidence trail motif and stem geometry**

Reuse the same branch/stem visual language across organization, recovery/evidence, and architecture. Keep it subtle enough that the visual motif is discovered rather than announced.

- [ ] **Step 6: Implement the final architectural Easter egg**

At the architecture/proof interaction state, the branch geometry may subtly form the cherry mark. This must be deterministic, subtle, and absent when reduced motion is enabled if the reveal relies on motion.

- [ ] **Step 7: Run composition tests**

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add site/src/App.tsx site/src/sections site/src/components/DepthIndicator.tsx site/src/demo/controller.tsx site/test/components.test.tsx
git commit -m "feat: compose full guided product exploration"
```

---

# 17. Task 16 — Implement responsive behavior and mobile-specific interactions

**Files:**
- Modify: `site/src/styles/responsive.css`
- Modify: `site/src/styles/layout.css`
- Modify: all interactive section/components
- Create: `site/e2e/landing.spec.ts`
- Test: `site/e2e/landing.spec.ts`

**Interfaces:**
- No new public API; responsive behavior is component/rendering contract.

- [ ] **Step 1: Write failing mobile smoke tests**

Using Playwright with a mobile viewport, assert:

1. menu opens/closes;
2. organization can be inspected by tap;
3. mandate panel fits without horizontal scroll;
4. execution timeline is vertical;
5. receipt fields stack;
6. architecture layers expand;
7. CTA form is reachable;
8. document width never exceeds viewport by a material amount.

- [ ] **Step 2: Run e2e tests before mobile implementation**

Run: `npm --prefix site run e2e -- --grep mobile`
Expected: FAIL for unimplemented behavior.

- [ ] **Step 3: Implement breakpoints**

Use the locked responsive strategy around `<768px`, `768–1100px`, and `>1100px`, but keep component behavior fluid within those ranges.

- [ ] **Step 4: Implement mobile visual transformations**

Apply exactly:

- graph → vertical flow;
- hover → tap-to-expand;
- dashboard → stacked cards;
- horizontal execution timeline → vertical timeline;
- architecture graph → vertical expandable stack.

- [ ] **Step 5: Implement mobile menu focus behavior**

On open, focus the first menu item. On close, return focus to the menu trigger. Escape closes the menu. Navigation selection closes it.

- [ ] **Step 6: Run Playwright mobile tests**

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add site/src/styles site/src/components site/src/sections site/e2e/landing.spec.ts
git commit -m "feat: add responsive mobile product exploration"
```

---

# 18. Task 17 — Accessibility, reduced motion, media fallback, and interaction robustness

**Files:**
- Modify: `site/src/components/Reveal.tsx`
- Modify: `site/src/components/PromoVideo.tsx`
- Modify: interactive components
- Modify: `site/src/styles/motion.css`
- Create: `site/test/accessibility.test.tsx`
- Modify: `site/e2e/landing.spec.ts`

**Interfaces:**
- `function useReducedMotion(): boolean` may be extracted if needed; it must subscribe/unsubscribe to `matchMedia` changes.

- [ ] **Step 1: Write failing accessibility tests**

Assert:

- one `h1`;
- heading hierarchy is valid;
- all interactive elements have accessible names;
- focus-visible styles exist;
- status is not conveyed only by color;
- video has an accessible label and transcript/caption path;
- navigation is keyboard operable;
- dialogs/expanded regions expose state with `aria-expanded` where applicable.

- [ ] **Step 2: Write failing reduced-motion tests**

Mock `prefers-reduced-motion: reduce` and assert:

- no animation delay is required for comprehension;
- demo advances through states without animation pauses;
- automatic ornamental transitions are disabled;
- IntersectionObserver reveals content immediately.

- [ ] **Step 3: Implement reduced-motion controls globally**

Use `@media (prefers-reduced-motion: reduce)` and the `useReducedMotion()` hook only when JavaScript behavior needs to change.

- [ ] **Step 4: Implement media fallbacks**

Video errors/missing assets must expose the poster and transcript. Do not block the page on media loading.

- [ ] **Step 5: Implement focus and keyboard contracts**

All expandable content must be operable with Enter/Space. Do not rely on hover for access to critical information.

- [ ] **Step 6: Run accessibility/Playwright tests**

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add site/src site/test/accessibility.test.tsx site/e2e/landing.spec.ts
git commit -m "feat: harden landing accessibility and reduced motion"
```

---

# 19. Task 18 — SEO, metadata, structured HTML, robots, sitemap, and share image

**Files:**
- Modify: `site/index.html`
- Create: `site/public/robots.txt`
- Create: `site/public/sitemap.xml`
- Create: `site/public/og-image.svg` (or optimized raster equivalent)
- Test: `site/test/seo.test.ts`

**Interfaces:**
- Static metadata values live in `site/index.html`; the public page content lives in semantic React markup.

- [ ] **Step 1: Write failing SEO tests**

Assert title, description, canonical link, Open Graph title/description/image, Twitter card, robots, and sitemap are present in the build output.

- [ ] **Step 2: Implement metadata**

Use product language only. Avoid unsupported “best”, “fastest”, or model-specific descriptions.

Suggested title:

`CherryOnTop — AI teams you can hold accountable.`

Suggested description:

`Give autonomous AI work a goal, a mandate, a budget, and a way to prove the result.`

- [ ] **Step 3: Implement semantic heading structure**

The actual marketing story must be in semantic HTML; do not move all meaningful copy into canvas/SVG/video.

- [ ] **Step 4: Add robots and sitemap**

Sitemap should use the final production origin from deployment config or be templated as part of deployment. Do not commit a fake domain as canonical.

- [ ] **Step 5: Run SEO tests and build**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add site/index.html site/public/robots.txt site/public/sitemap.xml site/public/og-image.svg site/test/seo.test.ts
git commit -m "feat: add marketing SEO and share metadata"
```

---

# 20. Task 19 — Performance optimization and asset loading strategy

**Files:**
- Modify: `site/vite.config.ts`
- Modify: `site/src/components/PromoVideo.tsx`
- Modify: styles and heavy components as needed
- Create: `site/test/performance-contract.test.ts`
- Modify: `docs/marketing/deployment.md`

**Interfaces:**
- `PromoVideo` must expose lazy media loading behavior without changing the public component API.

- [ ] **Step 1: Write failing performance-contract tests**

Assert that the video is not eagerly fetched before it is near/within the viewport (test with a mocked IntersectionObserver or `preload="none"` contract), heavy visual effects are not infinite-running when offscreen, and the initial HTML contains semantic hero content independent of media.

- [ ] **Step 2: Implement media loading strategy**

Use poster-first. Load the video when its container is relevant. Prefer compressed WebM/MP4 variants where actual browser support and deployment size justify both; keep one reliable MP4 fallback.

- [ ] **Step 3: Keep animations lightweight**

Use CSS transforms/opacity for most transitions. Avoid expensive continuous paint effects, massive DOM graphs, and unnecessary blur filters.

- [ ] **Step 4: Pause non-visible effects**

Where a component contains timers or repeated animation work, pause/unsubscribe when the component is not visible.

- [ ] **Step 5: Ensure production caching**

Static hashed assets get long immutable caching. HTML and API responses remain appropriately revalidated/non-cached.

- [ ] **Step 6: Run build and performance contract tests**

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add site/vite.config.ts site/src site/test/performance-contract.test.ts docs/marketing/deployment.md
git commit -m "perf: optimize landing media and runtime effects"
```

---

# 21. Task 20 — Serve the site and API together and document deployment

**Files:**
- Modify: `src/marketing/app.ts`
- Modify: `scripts/marketing-server.ts`
- Create: `docs/marketing/deployment.md`
- Create: `.env.marketing.example`
- Test: `src/marketing/app.test.ts`
- Modify: `package.json`

**Interfaces:**
- `buildMarketingApp(config)` registers static serving plus `/api/*`.
- `scripts/marketing-server.ts` loads config, builds app, starts listener, handles SIGINT/SIGTERM, and closes DB cleanly.

- [ ] **Step 1: Write failing production wiring test**

Build the site and start a test marketing server with a temporary DB. Assert:

`GET /` → landing HTML,
`GET /assets/...` → static asset,
`GET /api/health` → health,
`POST /api/waitlist` → accepted response.

Assert `/` and known static assets resolve correctly and that an unknown non-API route returns a normal 404; `/api/*` must never fall back to HTML.

- [ ] **Step 2: Implement static serving**

Use `site/dist` as the static root. Keep `/api/*` registered before SPA fallback. Apply immutable cache headers to hashed assets and short/no-cache to HTML.

- [ ] **Step 3: Implement graceful shutdown**

Close Fastify and the marketing DB on SIGINT/SIGTERM. Do not reuse the daemon's Laya/Kubernetes startup logic.

- [ ] **Step 4: Add environment template**

Document:

```text
MARKETING_PORT
MARKETING_HOST
MARKETING_DB_PATH
MARKETING_SITE_DIR
MARKETING_ALLOWED_ORIGIN
MARKETING_TRUST_PROXY
MARKETING_CONSENT_VERSION
VITE_PROMO_VIDEO_URL
VITE_SITE_ORIGIN
```

- [ ] **Step 5: Write deployment guide**

Cover:

1. build site;
2. set production environment;
3. start marketing server;
4. put TLS/reverse proxy/CDN in front if required;
5. configure trusted proxy flag only behind a trusted proxy;
6. point DNS at public site;
7. ensure media origin is allowed by CSP;
8. back up marketing DB;
9. run smoke checks;
10. monitor health endpoint.

- [ ] **Step 6: Run wiring test**

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/marketing scripts/marketing-server.ts docs/marketing/deployment.md .env.marketing.example package.json
git commit -m "feat: wire production marketing server and deployment"
```

---

# 22. Task 21 — Waitlist export and basic operations tooling

**Files:**
- Create: `scripts/export-marketing-waitlist.mts`
- Create: `src/marketing/export.test.ts`
- Create: `docs/marketing/operations.md`

**Interfaces:**
- `exportWaitlist(dbPath: string, outputPath: string): Promise<void>`.

- [ ] **Step 1: Write failing export tests**

Seed a temporary marketing DB, export it, and assert the CSV contains email, intent, consent version, and created timestamp columns without telemetry data.

- [ ] **Step 2: Implement export**

Require local filesystem access to the marketing DB; do not expose an unauthenticated HTTP export endpoint.

- [ ] **Step 3: Document operations**

Document DB backup, export, pruning telemetry, checking API health, and rotating the production host/secret environment configuration.

- [ ] **Step 4: Run test**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/export-marketing-waitlist.mts src/marketing/export.test.ts docs/marketing/operations.md
git commit -m "ops: add marketing waitlist export tooling"
```

---

# 23. Task 22 — Full browser smoke and narrative verification

**Files:**
- Modify: `site/e2e/landing.spec.ts`
- Create: `site/e2e/fixtures/test-api.ts`
- Modify: `package.json`
- Test: `site/e2e/landing.spec.ts`

**Interfaces:**
- Test server fixture starts the marketing API on a temporary port and serves the built site.

- [ ] **Step 1: Write the full narrative smoke suite**

The browser test must verify this order through visible DOM states:

```text
Hero
→ Organization
→ Mandate
→ Execution
→ Failure
→ Recovery
→ Validation
→ Receipt
→ Memory
→ Benchmarks
→ Architecture
→ CTA
```

The test should not depend on pixel-exact animation timing; use state markers and bounded retries.

- [ ] **Step 2: Test signature wow moments**

Assert:

1. goal becomes organization;
2. mandate shows “Human approval required”;
3. failure is visible before recovery;
4. receipt appears only after verified state;
5. architecture expands deeper layers.

- [ ] **Step 3: Test curious-path interactions**

Hover/click organization node → extra detail appears → click receipt → deeper detail → architecture expansion.

- [ ] **Step 4: Test reduced motion path**

Set `prefers-reduced-motion: reduce`; assert all meaningful content is visible without waiting through cinematic pauses.

- [ ] **Step 5: Test media-failure path**

Intercept the video request and fail it; assert poster/transcript fallback keeps the page usable.

- [ ] **Step 6: Test launch submission**

Use the test API fixture to accept a waitlist request; assert the exact success state.

- [ ] **Step 7: Run the full suite**

Run:

```bash
npm run marketing:verify
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add site/e2e package.json
 git commit -m "test: add full landing narrative browser coverage"
```

---

# 24. Task 23 — Visual polish pass and manual QA

**Files:**
- Modify: any `site/src/styles/*.css`
- Modify: section/component files only where visual evidence requires it
- Test: local browser manual QA + e2e smoke suite

**Interfaces:**
- No new API. This is a refinement pass against the locked visual grammar.

- [ ] **Step 1: Run the built site locally**

Run the production build and marketing server, not only Vite dev mode.

- [ ] **Step 2: Inspect desktop at representative widths**

Check at approximately 1440px and 1280px widths:

- hero hierarchy;
- product-first visual balance;
- no horizontal overflow;
- organization graph legibility;
- mandate tension/reveal;
- execution density;
- failure pause;
- validation payoff;
- receipt legibility;
- architecture depth;
- final CTA simplicity.

- [ ] **Step 3: Inspect mobile at representative widths**

Check approximately 390px and 430px widths:

- header/menu;
- hero hierarchy;
- vertical organization;
- authority panel;
- timeline;
- receipt;
- architecture accordion;
- form.

- [ ] **Step 4: Remove visual violations**

Delete anything that violates the core rule:

> Every visual element must explain the system, demonstrate the product, communicate state, or reward exploration.

Specifically remove random particles, generic “AI” glow, excessive card grids, meaningless stat animations, scroll hijacking, and decorative sound.

- [ ] **Step 5: Verify quiet/dense rhythm**

Make sure visually intense sections are followed by quieter space and that the page does not become uniformly dense.

- [ ] **Step 6: Run the full verification suite**

Run: `npm run marketing:verify`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add site/src
 git commit -m "polish: refine landing visual rhythm and product feel"
```

---

# 25. Task 24 — Final security/content/performance audit

**Files:**
- Modify: `docs/marketing/content-policy.md`
- Modify: `docs/marketing/deployment.md`
- Modify: any source files required by audit findings
- Test: full suite

**Interfaces:**
- No new public API. Audit the completed interfaces and deployment configuration.

- [ ] **Step 1: Run content-policy checks**

Run the content test and grep/build audit that confirms no forbidden competitor/model names or `open source` claims are present in public content.

- [ ] **Step 2: Run backend security checks**

Verify:

- payload limits;
- rate limits;
- no raw IP persistence;
- generic duplicate response;
- no internal stack traces in public responses;
- marketing DB isolated from runtime DB;
- no public tRPC route registration;
- CSP/headers present;
- `MARKETING_TRUST_PROXY` off unless explicitly configured.

- [ ] **Step 3: Run performance checks**

Build production bundle and inspect JS/media sizes. Confirm video is not part of the critical HTML payload beyond poster metadata.

- [ ] **Step 4: Run accessibility checks**

Keyboard only, reduced motion, focus-visible states, captions/transcript, and contrast inspection.

- [ ] **Step 5: Run the full verification suite**

Run:

```bash
npm run typecheck
npm test
npm run marketing:verify
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docs/marketing src/marketing site
 git commit -m "chore: finish marketing launch audit"
```

---

# 26. Task 25 — Documentation and handoff

**Files:**
- Modify: `README.md`
- Create: `docs/marketing/content-policy.md`
- Create: `docs/marketing/benchmarks.md`
- Create: `docs/marketing/analytics.md`
- Modify: `docs/marketing/deployment.md`
- Modify: `docs/superpowers/plans/2026-09-26-cherryontop-landing-page.md`

**Interfaces:**
- Documentation only; no runtime interface changes.

- [ ] **Step 1: Document developer workflow**

Explain:

```text
Terminal 1: npm run marketing:api
Terminal 2: npm run marketing:dev
```

and the one-command verification path.

- [ ] **Step 2: Document content guardrails**

State the model-agnostic, proprietary, product-first constraints and the rule that benchmark claims must include scope/methodology.

- [ ] **Step 3: Document analytics contract**

List the approved event names, safe metadata rules, batching, retention hook, and no-PII policy.

- [ ] **Step 3b: Document benchmark evidence**

Create `docs/marketing/benchmarks.md` with the exact controlled-comparison figures used on the site, their test population, repetitions, metric definitions, and limitations. The public page must link to this document so the benchmark section is auditable instead of being a standalone marketing assertion.

- [ ] **Step 4: Document deployment**

Explain same-origin serving, reverse proxy/trusted proxy behavior, DB backup, media host CSP configuration, and launch-form operations.

- [ ] **Step 5: Final documentation verification**

Run:

```bash
npm run marketing:verify
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/marketing docs/superpowers/plans/2026-09-26-cherryontop-landing-page.md
 git commit -m "docs: document marketing site implementation and operations"
```

---

# 27. End-to-End Wiring Summary

The final system should wire up as follows.

## Development

```text
Browser
  │
  ▼
Vite React app (site/)
  │
  ├── local deterministic demo state machine
  ├── static product/content data
  ├── poster/video media
  ├── first-party telemetry client
  │
  └── /api/* proxy
          │
          ▼
   Marketing Fastify (:4178)
          │
          ├── POST /api/waitlist
          ├── POST /api/analytics
          ├── GET  /api/health
          │
          ▼
   Dedicated marketing SQLite
```

## Production — preferred same-origin arrangement

```text
                         HTTPS
                           │
                           ▼
                    Reverse proxy / CDN
                           │
              ┌────────────┴────────────┐
              │                         │
              ▼                         ▼
       site static assets         Marketing Fastify
                                        │
                           ┌────────────┼────────────┐
                           ▼            ▼            ▼
                      /api/waitlist  /api/analytics /api/health
                           │            │
                           └──────┬─────┘
                                  ▼
                        marketing SQLite DB
```

Do **not** route the public browser to `src/server/app.ts` or the daemon's `/trpc` endpoint.

## Demo data flow

```text
DemoControllerProvider
        │
        ▼
   DemoSnapshot
        │
 ┌──────┼────────┬────────┬─────────────┐
 ▼      ▼        ▼        ▼             ▼
Hero  Org     Mandate  Execution     Receipt
                         │
                         ▼
                   Recovery/Validate
```

One state source controls all shared narrative transitions. Sections add local inspection UI but do not own separate lifecycle truth.

## Launch form flow

```text
User submits email
       │
       ▼
Client validation
       │
       ▼
POST /api/waitlist
       │
       ├── 400 → validation message
       ├── 429 → retry-safe message
       └── 200/202 → generic success
                    │
                    ▼
             SQLite INSERT OR IGNORE
```

Duplicate emails intentionally receive the same success shape as a new submission.

## Analytics flow

```text
UI interaction
     ↓
track(event, metadata)
     ↓
in-memory queue
     ↓
/beacon or keepalive fetch
     ↓
POST /api/analytics
     ↓
allowlisted schema
     ↓
marketing_events table
```

No email, repository path, model/provider name, or free-form user content enters telemetry.

---

# 28. Exact Content/Interaction Contract

The implementation is considered faithful to the approved design only when all of the following remain true.

## Hero

- `THE ACCOUNTABLE AI RUNTIME`
- `AI teams you can hold accountable.`
- `Give autonomous AI work a goal, a mandate, a budget, and a way to prove the result.`
- `Get CherryOnTop`
- `See how it works ↓`
- `Built for autonomous work that needs to get done—and checked.`

## Problem

- `AI can do the work. But who controls it?`
- `WHAT DID IT KNOW?`
- `WHAT WAS IT ALLOWED TO DO?`
- `DID IT ACTUALLY WORK?`

## Organization

- `One goal. An accountable AI organization.`
- `Frontend`, `Backend`, `Data`, `Verification` as the responsibility vocabulary.

## Mandate

- `Autonomy without a blank cheque.`
- blocked deployment example;
- `Human approval required`;
- `Development` vs `Deployment` authority distinction.

## Execution

- `Real work doesn't always go perfectly.`
- concrete operational signals;
- visible failure;
- recovery;
- verification.

## Validation

- `Done isn't enough. Prove it.`
- `47 / 47 checks passed`;
- `VERIFIED`.

## Receipt

- `Every important decision leaves a receipt.`
- objective, decision, authority, budget, spend, actions, artifacts, validation, human intervention, outcome.

## Memory

- `The organization remembers what it learned.`
- `Observed → Validated → Remembered → Reused`.

## Performance

- `Spend intelligence where it matters.`
- scope-qualified benchmark evidence;
- methodology link.

## Architecture

- `Under the interface is a real execution system.`
- `YOUR GOAL → CONTROL PLANE → EXECUTION → VALIDATION → PROOF`.

## Trust

- `Built to be inspected.`

## Final CTA

- `CherryOnTop is launching soon.`
- `Be among the first to get access.`
- `Join the launch`
- `You're on the list.`

---

# 29. Visual/Behavioral QA Matrix

| Feature | Desktop | Mobile | Reduced motion | Static fallback |
|---|---|---|---|---|
| Goal → organization | staged spatial branch | vertical sequence | immediate state change | full organization visible |
| Node inspection | hover + click | tap + click | no animation | detail panel remains accessible |
| Mandate refusal | inline authority panel | full-width panel | instant reveal | refusal is visible |
| Execution | horizontal/compact timeline | vertical timeline | no timed pauses | all events listed |
| Failure | stop motion | dedicated state block | no pause | failure text retained |
| Recovery | animated return | sequential cards | immediate state | steps visible |
| Validation | convergence/payoff | stacked result | immediate | verified result visible |
| Receipt | expandable product artifact | stacked expandable artifact | instant | all fields accessible |
| Memory | run-to-run flow | vertical flow | instant | both runs visible |
| Architecture | expandable graph | expandable stack | instant | all top-level layers visible |
| Video | poster + media | poster + media | poster/transcript-first | transcript/poster |
| Navigation | inline nav | menu | instant | normal links |
| Launch form | inline | stacked | no transitions required | form + success/error states |

---

# 30. Completion Gate

The implementation is ready for production review only when:

- the full page narrative is present in the approved order;
- all signature wow moments are deterministic and understandable without them being required for comprehension;
- the demo is clearly a controlled product demonstration, not a live workload;
- no prohibited public positioning/claims appear;
- the existing Electron GUI and runtime daemon still pass their existing test/build suites;
- marketing backend tests pass independently;
- site unit tests pass independently;
- browser smoke tests pass on desktop and mobile;
- reduced-motion and keyboard paths pass;
- video failure fallback passes;
- launch submission succeeds against the marketing API;
- duplicate waitlist submission cannot be enumerated;
- telemetry is allowlisted and contains no PII fields outside the explicit launch form database;
- production static/API wiring is same-origin or has an explicitly configured, trusted CORS boundary;
- CSP/security headers are present;
- SEO metadata is present;
- performance remains acceptable with the promo video deferred;
- deployment/operations documentation is complete.

---

# 31. Verification Commands

At minimum, the final implementation must pass:

```bash
npm run typecheck
npm test
npm run marketing:typecheck
npm run marketing:test
npm run marketing:build
npm run marketing:e2e
npm run marketing:verify
```

For production-equivalent smoke verification:

```bash
npm run marketing:build
npm run marketing:api
# then run the browser smoke suite against the production build
npm run marketing:e2e
```

Do not report completion based on a build alone; use the full verification set above.

---

# 32. Recommended Execution Order

Implement the tasks sequentially because later work consumes earlier interfaces:

```text
1 Foundation
  ↓
2 Design system
  ↓
3 Content/brand
  ↓
4 Demo state machine
  ↓
5 Product primitives
  ↓
6 Hero/video
  ↓
7 Organization
  ↓
8 Mandate
  ↓
9 Execution/recovery/validation
  ↓
10 Receipt/memory
  ↓
11 Benchmarks/architecture/nav/CTA
  ↓
12 Backend
  ↓
13 Launch form wiring
  ↓
14 Analytics
  ↓
15 Full composition
  ↓
16 Mobile
  ↓
17 Accessibility
  ↓
18 SEO
  ↓
19 Performance
  ↓
20 Production wiring
  ↓
21 Operations
  ↓
22 Browser narrative tests
  ↓
23 Visual polish
  ↓
24 Final audit
  ↓
25 Handoff docs
```

Every task ends with its own test cycle and commit. Do not batch unrelated tasks into one large change.

---

# 33. Final Implementation Principle

> **Software product first. Marketing page second.**

> **The page should not merely show CherryOnTop. It should behave like CherryOnTop.**

> **Astonishment should come from discovering what the product can do—not from visual effects.**

> **One goal → one organization → one execution story → one verified result.**
