# Benchmarking System-1: Claude Code vs CherryOnTop + Laya

**The objective is whole-harness performance.** A System-1 improvement that raises
whole-run cost, latency, coordination or failure rate is a regression, however good the
judgments look in isolation (spec §27). This guide covers what to run, in what order,
and how to read the result.

## Three levels, cheapest first

| Level | Command | Spends model tokens | Answers |
|---|---|---|---|
| 1. Decision cases | `npm run build && node bench/system1-decision-cases.mjs --out=s1-cases.jsonl` | No | Does Laya give the expected decision shape for each workload class, and what does one decision cost in latency? |
| 2. Ablation | `node bench/run.mjs system1 --goals=…` | Yes | What does Laya change in CherryOnTop, compared with its own conservative fallbacks (`ORG_SYSTEM1=off`)? |
| 3. **Whole harness** | `node bench/tier-b/run_instance.mjs <direct\|cherryontop> <task> <rep> <budgetUsd> out.jsonl` | Yes | **Claude Code alone vs CherryOnTop + Laya** on identical tasks. This is the headline. |

Run level 1 before paying for 2 or 3. If a clear-cut case fails there (the
model-initiated `A`/`B` choice, or the historical review being split), no whole-harness
run will be interpretable.

## Workload classes

`bench/system1-decision-cases.mjs` exports `WORKLOADS`, the seven classes a whole-harness
run must cover before it can claim System-1 helped:

| Class | Expected decision shape | Why it is in the set |
|---|---|---|
| historical coherent repo-wide investigation: *"Review the codebase and check for bugs, no edits"* | not split | The documented failure: breadth alone once sent this to five agents. |
| single-file change | not split, **and Laya not asked** | Economics can never delegate it, so asking would be pure overhead (§16). |
| coherent global investigation | not split | One root cause, however many packages it spans. |
| multiple independent workstreams | split | The case delegation exists for. |
| ambiguous implementation choice | (recorded, no expectation) | Makes drift between runs and checkpoints visible. |
| validation failure requiring recovery | not split | Recovery is not a fan-out. |
| model-initiated decision request | choice `A` | A clear-cut choice. A wrong answer is a provider problem. |

## Metrics

**Primary (whole harness, both arms):** task success, final quality (graded), total
tokens, input/cache tokens, output tokens, cost, wall time, turns, retries, validation
failures, recovery count. Tier-B rows already carry these, and grading is
`bench/tier-b/grade.mjs`.

**System-1 diagnostics (CherryOnTop arm only):** every Tier-B `cherryontop` row now has a
`system1` object summed from the run's efficiency records:

```text
system1Calls           provider round trips, retries included
system1Questions       questions asked (a batch of 3 is 3 questions, 1 call)
system1CachedAnswers   repeats answered free
system1LatencyMs       wall time spent waiting on System-1
system1InputTokens     provider tokens (Laya reports these; they are not model tokens)
system1Failures        epochs where the provider failed
system1Fallbacks       epochs where a deterministic fallback decided instead
system1Epochs          decision epochs reached
system1Candidates      legal options offered across questions
modelDecisionRequests  <cto_decide> frames the execution model emitted
```

The same fields appear in `summarizeEconomicRun(...).system1` for `bench/run.mjs`. They
**explain** a whole-harness difference and are never the thing optimized. Every judgment
also has a `system1.judgment` event with its full receipt, so a surprising run can be
traced to the exact question, digest, probability and fallback that shaped it.

## Rules

- **Identical workloads and environment for both arms.** `bench/compare.mjs` refuses
  unpaired runs (goal, revision, provider, models, environment fingerprint). The Tier-B
  runner pins the model (`claude-sonnet-5`) for both arms.
- **Keep raw per-run data.** Every runner appends JSONL. Keep those rows, not only summary
  tables.
- **Inspect outliers, not only averages.** For every expensive or failing CherryOnTop run,
  read its `system1.judgment` events: was a split made on a low-probability yes? Was
  Laya asked where the gate should have skipped it? Did a fallback fire?
- **Do not remove a proven mechanism on one noisy result.** See
  `docs/superpowers/system1-preservation-gates.md` for the evidence ladder.
- **If overhead is the problem, fix admission first.** Reduce how often questions are
  asked (gates, dedup, batching) before degrading what is asked.

## Status

- Levels 1–3 are wired and unit-tested (`bench/system1-decision-cases.test.mjs`,
  `bench/metrics/economic.test.mjs`).
- Level-1 numbers from a live Laya run, if recorded, are in the PR description for this
  change.
- Levels 2 and 3 need a logged-in `claude` and a kind cluster, and spend real usage.
  They have **not** been run for this change. Treat any claim of whole-harness benefit
  as unmeasured until they are.
