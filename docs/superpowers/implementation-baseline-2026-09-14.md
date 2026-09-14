# Implementation Baseline — Dynamic Agent-First Economic Execution Architecture

Frozen 2026-09-14, immediately before Task 2 of
`2026-09-14-dynamic-agent-first-economic-execution-architecture-implementation-plan.md`.

Nothing in this file is a target. It is the *before* half of every comparison the
plan later makes, so it records what was measured rather than what was hoped for.

## Source revision

| | |
|---|---|
| Branch | `feat/token-efficiency-architecture` |
| Commit | `935f5ac76509d24de97809c558c4606ae90a777b` |
| Working tree | clean (`git status --short` empty) |
| `package-lock.json` | `npm ci` reproducible; lock committed at the SHA above |

## Runtime and tool versions

| Tool | Version |
|---|---|
| Node | v22.22.2 |
| npm | 11.17.0 |
| git | 2.34.1 |
| TypeScript | ^7.0.2 (devDependency) |
| Vitest | ^5.0.0 |

## Unit test command and result

```bash
npm run test:unit
```

`VITEST_SUITE=unit vitest run` — **122 files, 1036 tests, all passing**, 7.02s.

Two deliberate self-check fixtures print `FAILED` lines inside passing tests
(`Node.js version: v20.11.0 — need >= 22`, `broken: missing dependency`); they are
assertions *about* failure formatting in `doctor`, not failures.

Other suites, unchanged by this plan's baseline:

```bash
npm run test:integration
npm run test:e2e        # builds first
npm run typecheck
```

## Deterministic context-planner behaviour

Produced by `scripts/baseline-receipts.mts` against this working tree at
`ORG_REPO_MAP_TOKENS=6000` (the default) with the structural planner on
(`ORG_CONTEXT_PLANNER` unset → enabled).

| Goal shape | Goal | Policy budget | Est. tokens | Candidates | Selected | Confidence |
|---|---|---:|---:|---:|---:|---:|
| tiny | `Fix a typo in README.md` | 1200 | 392 | 6 | 6 | 1.00 |
| medium | `Add a unit test for src/engines/economics.ts scoreDelegation tolerance behaviour` | 1425 | 621 | 31 | 15 | 0.56 |
| broad | `Review the codebase and find bugs. Do not modify anything.` | 4344 | 426 | 2 | 1 | 0.50 |
| low-confidence | `make it better` | 2760 | 409 | 0 | 0 | 0.00 |

Raw receipts:

```json
{"label":"tiny","budget":1200,"estimatedTokens":392,"candidates":6,"selected":6,"truncated":false,"confidence":1,"policyVersion":"ctx-1","structural":true,"topSelected":["test/e2e/README.md","test/k8s/README.md","test/unit/README.md","test/integration/README.md","README.md"]}
{"label":"medium","budget":1425,"estimatedTokens":621,"candidates":31,"selected":15,"truncated":false,"confidence":0.56,"policyVersion":"ctx-1","structural":true,"topSelected":["src/engines/economics.test.ts","src/engines/economics.ts","src/engines/decide-execution.ts","src/engines/counterfactual.test.ts","test/unit/README.md"]}
{"label":"broad","budget":4344,"estimatedTokens":426,"candidates":2,"selected":1,"truncated":false,"confidence":0.5,"policyVersion":"ctx-1","structural":true,"topSelected":["src/db/migrations/0006_groovy_bug.sql"]}
{"label":"low-confidence","budget":2760,"estimatedTokens":409,"candidates":0,"selected":0,"truncated":false,"confidence":0,"policyVersion":"ctx-1","structural":true,"topSelected":[]}
```

Two observations worth carrying forward as *hypotheses*, not findings:

- The broad goal is given the **largest** budget (4344) and finds the **fewest**
  candidates (2) — of which the top hit is `0006_groovy_bug.sql`, matched purely
  on the word "bug" in a migration filename. A goal with no lexical anchors gets
  no structural seeds either, because structural relevance is measured *from*
  anchors. This is exactly the information-poor regime the plan's evidence
  economics is meant to address.
- `make it better` produces zero candidates and falls back to the repository
  skeleton alone. Uncertainty currently widens the *budget* but has nothing to
  spend it on.

## Current behaviour of the two arms

**Baseline** today means `ORG_CONTEXT_PLANNER=off` (lexical selection) plus the
flat configured turn cap. It is the arm the recorded token-efficiency baseline
was measured on.

**Full Architecture** today means the structural context planner
(`candidates.ts` → `scoring.ts` → `selector.ts`), adaptive turn/context policy
(`efficiency/policy.ts`), the spend guard, model tiering, plan/result caches, and
the `decision/engine.ts` receipt contract.

`src/config/efficiency.ts` currently exposes a **third** product mode,
`ORG_EFFICIENCY_MODE=shadow`. Plan Task 23 requires exactly two product runtime
modes; removing `shadow` from product configuration is therefore a required
change, not an optional one, and is tracked there.

## Benchmark environment invariants

`bench/run.mjs` dispatches real, paid model calls and requires:

| Requirement | Value at baseline |
|---|---|
| Cluster | a live `kind` cluster, namespace `org-exec` (`ORG_K8S_NAMESPACE`) |
| CLI | `org` on `PATH` (built via `npm run build`) |
| Credentials | `claude login` OAuth, or `ANTHROPIC_API_KEY` |
| Runner image | `cherryontop-runner:local` (`./scripts/build-runner-image.sh`), overridable by `ORG_RUNNER_IMAGE` |
| Goal fixture | `bench/goals.json`, `goals[]` frozen (7 goals); `families[]` off unless `--families` |
| Models | `ORG_MODEL_PLAN=haiku`, `ORG_MODEL_SYNTHESIZE=haiku`, `ORG_MODEL_EXECUTE` unset |
| Turn caps | `ORG_MAX_TURNS_PLAN=2`, `ORG_MAX_TURNS_SYNTHESIZE=1`, `ORG_MAX_TURNS_EXECUTE=60` |
| Fan-out | `ORG_MAX_CHILD_JOBS=2` |
| Context | `ORG_REPO_MAP_TOKENS=6000` |
| Caches | `ORG_PLAN_CACHE_TTL_HOURS=24`, `ORG_RESULT_CACHE_TTL_HOURS=24` |
| Concurrency | one benchmark process; sandbox limiter is per-daemon |

Deterministic, unpaid harnesses that CI can run:

```bash
npm run bench:deterministic   # bench/deterministic.mjs
npm run bench:guard           # bench/economic-trajectories.mjs
```

Known contamination risk recorded here because Task 32 must fix it: the daemon
uses a single SQLite file and a fixed port, so two benchmark arms run
concurrently would share a database and a port.
