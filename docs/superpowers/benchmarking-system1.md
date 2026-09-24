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

## Recorded: level 1 against live Laya (2026-09-24)

`laya-serve` 0.3.11, `typed-decisions` checkpoint, CUDA (RTX 3060 laptop GPU), revision on
branch `feat/system1-laya-decision-architecture`.

| Workload | Before calibration (raw, sorted options) | After (`@2` question, Platt) | Expected |
|---|---|---|---|
| historical coherent review | split (P 0.35 ≥ 0.33) ✗ | not split (P 0.017) ✓ | not split |
| single-file change | not asked ✓ | not asked ✓ | not asked |
| coherent global investigation | split ✗ | split (P 0.94) ✗ | not split |
| independent workstreams | split ✓ | split (P 0.95) ✓ | split |
| ambiguous implementation choice | split (P 0.41) | split (P 0.25, threshold 0.20) | (recorded) |
| validation failure → recovery | split ✗ | not split (P 0.037) ✓ | not split |
| model-initiated choice | A (0.53/0.47) ✓ | A ✓ | A |
| **matches** | **4 / 7** | **6 / 7** | |

Latency: first question after start ~1.9 s (CUDA warm-up), then **23–73 ms per question**.
The remaining miss is a real Laya limitation: the raw output leans `many` (0.70) for
"find out why the whole test suite became slow across every package". It is kept in the
calibration set as a negative and not tuned around.

Calibration evidence (`node bench/system1-calibrate.mjs`, 40 labelled goals, leave-one-out):
decision accuracy **0.700** (Laya + calibration + economics boundary) vs **0.575** (regex
heuristic), log loss 0.569 (identity) → 0.492 (Platt). Forty hand-labelled goals is a
starting point. Refit from real orchestration outcomes once Tier-B runs exist.

## Recorded: Tier-B, Claude Code vs CherryOnTop + Laya (2026-09-24)

Sonnet 5 on both arms, $5 cap per run, one repetition, graded by each task's own tests.
Raw rows: `bench/tier-b/results/system1-main.jsonl` and `grading.jsonl`.

| Task | Arm | Official grade | Tests | Spend (true) | Wall |
|---|---|---|---|---|---|
| cargo-flight-dispatch | Claude Code | fail | 19/27 | $1.07 | 7.0 min |
| cargo-flight-dispatch | CherryOnTop + Laya | fail | 19/27 | $0.94 | 6.2 min |
| vba-userform-port | Claude Code | fail | 0/28 traces (stopped at cap) | ~$3.34 | 11.5 min |
| vba-userform-port | CherryOnTop + Laya | fail | 0/28 (no `run.sh` written) | ≥ $4.18 | 45 min |

Neither harness solved either task, so quality is a tie. CherryOnTop was 12% cheaper on
the task it finished in one attempt. It was slower and more expensive on the long task,
because every execute attempt is capped at 10 minutes and all three attempts were cut
off before the app was complete. An earlier CherryOnTop VBA run is excluded as invalid:
the account's five-hour usage window was exhausted and both attempts were refused at 0
tokens.

System-1 behaviour: for flight-dispatch the split question was not asked (economics
could not justify delegating). For the VBA port Laya said decomposable (P=0.94); the
planner's split was then wrongly rejected (bug, fixed), and on the rerun the planner
ran out of turns. The execution model never chose to use `<cto_decide>` on these tasks.

Bugs this benchmark exposed, all fixed on this branch: the grader passing a 0/28 run,
the daemon ignoring `ORG_*` settings including the spend cap, the delegation validator
rejecting every split of a long spec, a failed planner cached as "does not split",
killed runs recorded as ~$0, and the runner pricing Sonnet 5 at the old $3/$15.

Not changed: the 10-minute per-attempt Job timeout. It is what decided the VBA result.
Raising it for long tasks is the next thing to measure.

## Status

- Levels 1–3 are wired and unit-tested (`bench/system1-decision-cases.test.mjs`,
  `bench/metrics/economic.test.mjs`).
- Level 1 has been run against live Laya (above).
- Level 3 (Tier-B) has been run once per task per arm (above). One repetition on two
  tasks cannot show a difference; it shows the harness works end to end.
