# Full CI & Test Suite — Adapted Plan

> Adapted from `CherryOnTop-full-ci-test-suite-plan.md` after auditing the actual
> state of `feat/token-efficiency` @ `9d05c2b`. That audit found most of the
> original plan's infrastructure already built: 117/142 `src/` files have unit
> tests (826 passing), typecheck is clean, coverage is 75.8%/70.2%/74.9%/76.9%
> against already-enforced 70/65/70/70 thresholds, and all six CI workflow files
> (`ci.yml`, `integration.yml`, `e2e.yml`, `k8s.yml`, `gui.yml`, `benchmarks.yml`)
> already exist with per-layer separation, push-on-every-branch, and
> artifact-on-failure. This plan targets only the gaps that audit actually found.

**Goal:** Close the real, verified gaps in CherryOnTop's test suite and CI
without duplicating existing coverage: untested CLI commands and tRPC routers,
missing invariant/property tests, a missing fixture/golden-corpus layer, one
misclassified integration test, and a coverage/docs hardening pass.

**Spec:** `CherryOnTop-full-ci-test-suite-plan.md` (original, for context and the
Required Test Matrix / Mandatory Invariants sections, both still binding),
`docs/2026-09-11-token-efficiency.md`, `docs/2026-09-11-token-efficiency-progress.md`.

## Global Constraints

- Work happens on `feat/full-ci-test-suite`, branched from `feat/token-efficiency`
  @ `9d05c2b`, in the worktree at `.worktrees/full-ci-test-suite`.
- Node 22 is the supported floor. `npm test` = `npm run test:unit` = the
  deterministic every-push gate. Do not change this contract.
- Unit tests (`VITEST_SUITE=unit`) must not require a live Kubernetes cluster,
  Docker, a paid model API, network access, or credentials. Mock/fake at the
  boundary; never mock the module under test.
- Integration tests (`VITEST_SUITE=integration`) may use real SQLite/filesystem/
  process boundaries but never a real K8s cluster. K8s-dependent tests belong
  in `VITEST_SUITE=k8s` only — see Task 3, which is the concrete fix for the one
  test currently misrouted this way.
- No blind retries for deterministic tests. A flaky test fails and gets fixed at
  the root cause, not retried.
- Tests assert observable contracts, not implementation details. Follow the
  existing conventions exactly: `src/server/routers/node.test.ts` and
  `src/server/app.test.ts` (Fastify `app.inject` against `buildServer(testDb, ...)`)
  for router tests; `src/cli/commands/doctor.test.ts` and
  `src/cli/validation.test.ts` for CLI tests; `test/helpers/test-db.ts`,
  `test/helpers/temp-worktree.ts`, `test/helpers/fake-clock.ts`,
  `test/helpers/fake-process.ts`, `test/helpers/assertions.ts` for shared
  fixtures — read these before writing new tests in their area, and extend
  them rather than inventing parallel helpers.
- Every new test file must pass in `npm run test:unit` (or the correct suite)
  in isolation and as part of the full suite, deterministically, in parallel.
- Every task ends with its own focused test command and must not regress the
  global coverage thresholds already in `vitest.config.ts` (70/65/70/70).
- Do not touch `src/adapters/stopgap.ts`, `src/execution/credentials.ts`, or the
  SELF_EXECUTE credential-gate in `src/lifecycle/node-actor-manager.ts` — the
  local test failure investigated during planning was traced to an expired
  local Claude OAuth login on the audit machine, not a product defect. That
  gate is out of scope for this plan.

---

## Task 1: CLI command unit tests

**Files:**
- Create: `src/cli/commands/approvals.test.ts`
- Create: `src/cli/commands/approve.test.ts`
- Create: `src/cli/commands/commitment.test.ts`
- Create: `src/cli/commands/daemon.test.ts`
- Create: `src/cli/commands/decision.test.ts`
- Create: `src/cli/commands/gui.test.ts`
- Create: `src/cli/commands/run.test.ts`
- Create: `src/cli/commands/tokens.test.ts`
- Create: `src/cli/commands/tree.test.ts`
- Create: `src/cli/commands/verify.test.ts`
- Create: `src/cli/index.test.ts`
- Read (do not modify unless a test exposes a genuine defect): every file above
  minus `.test.ts`.

**Pattern to follow:** `src/cli/commands/doctor.test.ts` and
`src/cli/validation.test.ts` — call exported functions directly with
injected dependencies where the command already supports that; only shell out
via `execa` (as `doctor.test.ts` does for binary probes) when a command has no
importable pure function. Do not restructure a command file to make it
testable if it is already exporting what it needs — check first.

**Coverage per file (apply what's applicable — not every command has every
category, e.g. `tree.ts` at 15 lines may only need happy-path + empty-input):**
- Valid invocation with representative arguments.
- Missing required arguments / unknown flags / invalid enum values, and the
  resulting exit code and stderr message.
- Empty/malformed IDs where the command takes one (approve, decision,
  commitment, tokens).
- stdout vs stderr separation for machine-readable output where the command
  promises it (check existing CLI output conventions in `src/cli/index.ts`
  and `src/tui/format.ts` before assuming a shape).
- `src/cli/index.ts`: command registration — every subcommand is wired, an
  unknown subcommand fails with a clear error and non-zero exit.

**Verify:** `npx vitest run src/cli --project unit` (or
`VITEST_SUITE=unit vitest run 'src/cli/**/*.test.ts'`) — all new tests pass,
then `npm run test:unit` for the full gate, then `npm run test:coverage` to
confirm `src/cli/**` coverage rose and no global threshold regressed.

---

## Task 2: tRPC router unit tests

**Files:**
- Create: `src/server/routers/approval.test.ts`
- Create: `src/server/routers/artifact.test.ts`
- Create: `src/server/routers/ask.test.ts`
- Create: `src/server/routers/case.test.ts`
- Create: `src/server/routers/daemon.test.ts`
- Create: `src/server/routers/mandate.test.ts`
- Create: `src/server/routers/memory.test.ts`
- Read (do not modify unless a test exposes a genuine defect): the
  corresponding non-test file for each router above.

**Pattern to follow:** `src/server/routers/node.test.ts`,
`src/server/routers/decision.test.ts`, `src/server/routers/commitment.test.ts`,
`src/server/routers/events.test.ts`, and `src/server/app.test.ts` — build a
real Fastify app via `buildServer(TEST_DB, () => {})` from `../app.js`, hit it
with `app.inject({ method, url: '/trpc/<router>.<procedure>' })`, assert on
`response.statusCode` and `JSON.parse(response.body).result.data` (or
`.error` for failure cases). Use a uniquely named `TEST_DB` per file exactly
like the existing router tests, with the same `afterEach` WAL-file cleanup —
copy that block verbatim, do not invent a different DB fixture.

**Coverage per procedure:**
- Success case with seeded DB rows (use the existing `db/queries/*` insert
  helpers to seed, the same way other router tests do).
- Not-found / empty-result case.
- Invalid input (wrong type, missing required field) → the tRPC/Zod
  validation error path, not a thrown 500.
- Any router touching authority/approval/mandate state (approval.ts,
  mandate.ts): assert the response never includes broader authority/state
  than what's stored — this is the security-boundary check the plan's
  authority invariant calls for at the API layer.

**Verify:** `VITEST_SUITE=unit vitest run 'src/server/routers/**/*.test.ts'`,
then `npm run test:unit`, then `npm run test:coverage` — `server/routers`
coverage (currently ~21%/6%/14%/23%) must rise substantially; global
thresholds must not regress.

---

## Task 3: Fix K8s test suite misclassification (root-caused during planning)

**Root cause, verified live during planning on this machine:**
`src/lifecycle/autonomous-loop.integration.test.ts` requires a real reachable
Kubernetes cluster (`isClusterReachable()` gates its `describe.skipIf`, checked
at **module import time**, before its own `beforeAll` even calls
`ensureLocalCluster()`). It is currently glob-matched into the `integration`
Vitest project via `src/lifecycle/**/*.integration.test.ts` in
`vitest.config.ts`. `.github/workflows/integration.yml` never provisions a
Kind cluster, so in CI this test **silently skips** and provides zero signal.
It is *also* absent from the `k8s` project's `include` list, so
`.github/workflows/k8s.yml` — which does provision Kind via
`helm/kind-action@v1` — never runs it either. Net effect: this test has
**never executed in CI**, in either direction. The only time it runs for real
is on a developer machine that happens to already have a reachable
`kind-org-local` cluster and valid Claude credentials — which is exactly the
flaky-looking "existing K8s failure" the original plan's Global Constraints
referenced. (On this machine, confirmed independently: with a freshly
recreated cluster, zero K8s resources were created and the test failed in
~100ms — traced to an expired local OAuth token in
`src/execution/credentials.ts`'s `checkCredentials`, unrelated to cluster
state or to CherryOnTop's own job-dispatch code. That path is explicitly
out of scope per Global Constraints.)

The sibling file `src/lifecycle/wiring.integration.test.ts` matches the same
glob but mocks `../k8s/cleanup.js` entirely and needs no real cluster — it
must stay in the `integration` project.

**Files:**
- Modify: `vitest.config.ts`
- Create/modify: a regression test asserting the two lifecycle integration
  files land in the correct Vitest project (see below).

**Steps:**
1. In `vitest.config.ts`, remove `src/lifecycle/**/*.integration.test.ts` from
   the `integration` project's `include` and replace it with an explicit
   `src/lifecycle/wiring.integration.test.ts`.
2. Add `src/lifecycle/autonomous-loop.integration.test.ts` to the `k8s`
   project's `include` array.
3. Add a short comment above each `include` array (or above the changed
   lines) stating why the file is classified where it is — future additions
   to `src/lifecycle/*.integration.test.ts` should not default back into
   `integration` without checking whether they touch `../k8s/kind.js` for
   real.
4. Add a regression test (e.g. `test/unit/vitest-project-classification.test.ts`)
   that reads `vitest.config.ts`'s suite definitions (statically, e.g. via a
   small regex/AST check or by importing the config and inspecting the
   resolved `include` arrays for the `k8s`/`integration` keys — pick
   whichever is more robust without adding a new dependency) and asserts:
   `autonomous-loop.integration.test.ts` is in `k8s`'s include and NOT in
   `integration`'s; `wiring.integration.test.ts` is in `integration`'s
   include and NOT in `k8s`'s. This is the regression coverage for the root
   cause — a future edit that puts a K8s-dependent test back in the
   integration suite must fail this test.
5. Document this classification rule in `test/k8s/README.md` and
   `test/integration/README.md` (one or two sentences each, pointing at each
   other).

**Verify:**
- `VITEST_SUITE=integration vitest run` — `autonomous-loop.integration.test.ts`
  must not appear in the run at all; `wiring.integration.test.ts` must still
  pass.
- `VITEST_SUITE=k8s vitest run src/lifecycle/autonomous-loop.integration.test.ts`
  against a reachable cluster with valid credentials — confirms the test can
  still run in its correct project (skip is acceptable in this sandboxed
  review if credentials are unavailable; the reviewer should not require a
  live cluster to approve this task, only confirm the classification and the
  new regression test).
- `npm run test:unit` unaffected.

---

## Task 4: Test fixtures, golden corpus, and the missing shared helper

**Files:**
- Create: `test/helpers/fixtures.ts` (listed in the original plan's Section 1
  file inventory but never created — check `test/helpers/*.ts` first; do not
  duplicate `test-db.ts`/`temp-worktree.ts`/`fake-clock.ts`/`fake-process.ts`/
  `assertions.ts`, which already exist and are in use).
- Create: `test/fixtures/runtime-events/` — JSON fixtures for adapter event
  parsing: success, failure, rate-limit, timeout, usage, malformed JSON,
  unknown event type. Base these on the real shapes already asserted in
  `src/adapters/*.test.ts` and `src/intelligence/result-envelope.test.ts` —
  extract representative cases from there rather than inventing new ones.
- Create: `test/fixtures/repositories/` — minimal fixture repos (clean, dirty
  modified-tracked-file, untracked file, deleted-tracked-file) for use by
  `src/intelligence/repo-map.test.ts` and `src/context/dispatch-context*.test.ts`
  if they don't already build these inline; check first — if those tests
  already construct equivalent temp repos inline via
  `test/helpers/temp-worktree.ts`, do not duplicate as static fixtures, and
  instead skip this sub-item and note why in the task report.
- Create: `test/regressions/README.md` — one line per existing regression
  test already in the codebase (grep for "Regression:" comments across
  `src/**/*.test.ts` — there are several, e.g. `doctor.test.ts`'s kubectl
  probe fix) plus the new one from Task 3, each with the bug class it
  prevents.

**Constraints:** Fixtures are immutable inputs with no credentials or secrets.
Do not create a fixture for something already adequately covered by inline
test setup — the goal is filling the plan's named gap (this directory didn't
exist), not fixture-izing everything that currently works fine inline.

**Verify:** `npm run test:unit` — new fixtures are either used by at least one
test added/updated in this task, or the task report explains why a planned
fixture was skipped as redundant with existing inline setup.

---

## Task 5: Cross-module invariant and property-based tests

**Files:**
- Create: `test/invariants/context-budget.invariant.test.ts`
- Create: `test/invariants/cache-correctness.invariant.test.ts`
- Create: `test/invariants/authority.invariant.test.ts`
- Create: `test/invariants/receipts.invariant.test.ts`
- Create: `test/property/reducers.property.test.ts`

**These compose existing public APIs from multiple modules — no new
production code.** Read before writing:
`src/context/dispatch-context.ts` + `.test.ts`,
`src/context/dispatch-context-cache.ts` + `.test.ts`,
`src/engines/decide-execution.ts` + `.test.ts`,
`src/efficiency/ledger.ts` + `.test.ts`,
`src/execution/observation-reducer.ts` + `.test.ts` (or equivalent reducer
module — check the actual filename under `src/execution/`).

**Invariants to prove (per the original plan's Mandatory Invariants list —
only the ones with no existing dedicated test; check each module's existing
`.test.ts` first and skip any invariant already directly asserted there,
noting which in the task report):**
1. **Budget invariant:** generate randomized repo entries/goals/budgets
   (bounded random via a seeded PRNG — do not use `Math.random()` directly in
   a way that makes failures unreproducible; seed it and print the seed on
   failure) and assert `DispatchContext` selection never exceeds the given
   token budget.
2. **Determinism invariant:** same inputs to `dispatch-context` selection and
   to `decideExecution` produce byte-identical output across repeated calls.
3. **Cache invariant:** a `DispatchContextCache` hit and a cold recomputation
   with identical dependencies (repo HEAD, goal, budget) produce
   observationally equivalent results; mutating one dependency (change repo
   HEAD, or the goal string) invalidates reuse — assert a cache miss follows.
4. **Authority invariant:** `decideExecution` never returns `SELF_EXECUTE` or
   any outcome that grants more than `input.authority` allows — sweep a small
   matrix of authority combinations (spawn_children true/false ×
   max_child_count 0/1/N × budget below/at/above threshold) and assert the
   outcome never exceeds the granted authority.
5. **Receipts invariant:** for a `DispatchContext` selection result, assert
   `selected.length + dropped.length` reconciles with the deduplicated
   candidate set fed in (this mirrors Section 6 Step 7 of the original plan,
   but as a property over randomized candidate sets rather than one example).

**Property test for reducers:** bounded random input line counts (0 to a few
thousand), assert the reducer's output line count never exceeds its
documented maximum regardless of input size or duplicate density.

**Verify:** `npm run test:unit` including the new `test/invariants/**` and
`test/property/**` globs — confirm `vitest.config.ts`'s `unit` project
`include` already covers `test/unit/**/*.test.ts` and, if these new
directories aren't covered by an existing glob, add
`test/invariants/**/*.test.ts` and `test/property/**/*.test.ts` to the `unit`
project's `include` list (they're deterministic and dependency-free, so they
belong in the every-push gate, not integration).

---

## Task 6: Critical-module edge-case and security-boundary audit

**This is an audit-and-fill task, not a rebuild.** For each module below, read
its existing `.test.ts`, cross-reference against the Required Test Matrix in
the original plan (`CherryOnTop-full-ci-test-suite-plan.md`, bottom section),
and add only the missing cases. Do not rewrite passing tests.

**Modules to audit (chosen because they are decision/authority/policy-bearing
per the original plan's Sections 4 and 11, the highest-consequence code in
the repo):**
- `src/engines/decide-execution.ts` — boundary budgets (`requiredBudget - 1`,
  exactly `requiredBudget`), `max_child_count` at 0/1, malformed/missing
  `signals`.
- `src/approvals/**/*.ts` — creation, pending, approval, rejection, expiry,
  duplicate resolution, already-resolved-twice.
- `src/mandates/**/*.ts` (if this directory doesn't exist under this name,
  grep for mandate logic — it may live under `src/schemas/` or
  `src/server/routers/mandate.ts`'s backing module; use whatever the actual
  location is) — scope/action/budget restriction boundaries, expiry,
  mismatched node/mandate reference.
- `src/schemas/**/*.ts` — for every exported Zod schema without existing
  boundary tests: valid-minimum, valid-maximum, missing-required-field,
  extra-field (should it reject or strip? assert the actual, intended
  behavior), wrong-type, null, empty-string/array, enum exhaustiveness
  (reject unknown enum values).

**Negative-security case (apply wherever authority/scope is checked):** for
at least one test per module above, assert that a narrower authority/grant
cannot be widened by any input the caller controls — e.g. a node without
`spawn_children` cannot reach a delegating outcome no matter what `signals`
or `complexity` claims.

**Verify:** `npm run test:unit`, `npm run test:coverage` — branch coverage for
`src/engines`, `src/approvals`, `src/schemas` (and the mandate module,
wherever it resolves to) should be visibly higher than the pre-task baseline;
capture the before/after numbers in the task report.

---

## Task 7: Coverage policy hardening and testing documentation

**Files:**
- Modify: `vitest.config.ts`
- Modify: `.github/workflows/ci.yml`
- Create: `docs/testing.md`

**Steps:**
1. In `vitest.config.ts`'s coverage config, add per-directory threshold
   overrides (Vitest v8 coverage supports `coverage.thresholds` per-glob via
   the `thresholds` object's glob keys, or per `include` split — use whatever
   the installed `@vitest/coverage-v8` version actually supports; check its
   docs/types before writing config that silently no-ops) for
   `src/engines/**`, `src/approvals/**`, `src/schemas/**`, and
   `src/decision/**`, set higher than the global 70/65/70/70 — pick numbers
   the actual post-Task-6 coverage on this branch can sustain plus a small
   margin, not aspirational numbers that immediately fail CI. Run
   `npm run test:coverage` first to see real numbers before choosing
   thresholds.
2. Add a coverage-diff check to `ci.yml`'s `fast-quality-gate` job: compare
   this run's coverage summary against `main`'s last known coverage (a simple
   approach: fail if statement coverage drops by more than 1 percentage point
   versus the coverage artifact from the base branch — implement with what's
   already available, e.g. parsing `coverage/coverage-summary.json` if the
   `json-summary` reporter is added, no new dependency). If a clean
   base-branch comparison isn't practically achievable without a new
   dependency or external service, implement the simplest version that
   compares against a checked-in baseline number and document the tradeoff
   in `docs/testing.md` rather than leaving the step out silently.
3. Write `docs/testing.md`: one section per test layer (unit/integration/e2e/
   k8s/gui/benchmark) naming its npm script, its CI workflow file, what it
   covers, what it must never depend on, and the exact local command to run
   it standalone. Include the classification rule from Task 3. Include what
   each coverage threshold means and how to run coverage locally
   (`npm run test:coverage`, then open `coverage/index.html`).
4. Note mutation testing as a deliberately deferred, non-blocking follow-up
   (per the original plan's Section 19 Step 7) rather than implementing it in
   this task — record this as a documented decision in `docs/testing.md`,
   not a silent omission.

**Verify:** `npm run test:coverage` passes with the new per-directory
thresholds; `npm ci && npm run typecheck && npm run build && npm run test:unit
&& npm run test:coverage` all green; the coverage-diff step is exercised at
least once (a deliberate small coverage drop in a scratch branch, or a dry
run showing the comparison logic works) before being relied on.

---

# Required Verification Commands (unchanged from the original plan)

```bash
npm ci
npm run typecheck
npm run build
npm run test:unit
npm run test:coverage
npm run test:integration
npm run test:e2e
npm run test:k8s
npm run test:gui
```

# Definition of Done for this adapted plan

- [ ] Tasks 1–2: every CLI command and tRPC router file has direct test
      coverage following the established patterns.
- [ ] Task 3: the K8s test misclassification is fixed with a regression test;
      root cause is documented as environment/config, not product defect.
- [ ] Task 4: `test/helpers/fixtures.ts`, a runtime-event fixture corpus, and
      a regression-test index exist.
- [ ] Task 5: budget, determinism, cache, authority, and receipts invariants
      have dedicated property/invariant tests in the unit gate.
- [ ] Task 6: decision/authority/schema modules have verified matrix coverage
      per the original plan's Required Test Matrix, with before/after
      coverage numbers recorded.
- [ ] Task 7: per-critical-module coverage thresholds, a coverage-diff CI
      check, and `docs/testing.md` exist.
- [ ] `npm run test:unit`, `npm run test:coverage`, `npm run typecheck`, and
      `npm run build` are green at the end of every task.
- [ ] No task weakens or deletes an existing passing test to make room for a
      new one without a documented reason in its task report.
