# Full Architecture vs Baseline — real, paid, matched results

**Status: all three approved tiers ran — smoke pair, frozen population (7 goals),
regime suite (24 goals / 8 regimes) — 62 real dispatches total, all matched
Baseline vs Full Architecture on the same commit (`e088eae`).** This supersedes
the `n=1` smoke pair in
[2026-09-14-full-architecture-baseline-comparison.md](2026-09-14-full-architecture-baseline-comparison.md),
which could not compute the primary metric at all.

## Executive verdict

**Regression, with the clearest signal this project has produced.** The frozen
population (n=7) was noisy and directionless — every paired metric's sign test
said "no consistent direction." The regime suite (n=24, 8 regimes) is not: Full
Architecture uses **46.7% more tokens per successful task**, has a **lower
success rate** (79.2% vs 87.5%), and **31.3% higher p95 latency**, and it loses
the acceptance contract in **7 of 8 regimes** — including `hard-budget` and
`strategy-failure`, the two regimes the architecture's own resource-allocation
and recovery mechanisms are supposed to win. Quality was never scored (no
rubric was hand-graded), so nothing here proves the *baseline's* answers were
better — only that Full Architecture spent more to produce them, more often
without a validated definition-of-done, and failed outright more often.

Confidence: **moderate, not final — softer than the numbers below suggest.**
Regime n=3 per cell is smoke-scale by the plan's own sample plan (Phase 1), not
development-scale (8–12). Three real environment failures occurred and were
correctly excluded (see §5). More importantly, **the harness ran every goal
directly against the live working tree with no isolation between goals or
arms**, leaving 85 files of real, uncommitted cross-goal edits behind (see
§4) — a direct violation of the plan's own "same repository revision for
matched runs" invariant that nothing in the existing tooling would have
caught. No quality oracle ran either, so the plan's own hard floor — "a
cheaper incorrect result is a regression" — cannot be checked in the other
direction.

## 1. Revisions / environment

| | |
|---|---|
| Commit | `e088eaecde36a46ff2ccb6a4e7be12e16fe32c64` |
| Branch | `feat/token-efficiency-architecture` |
| Node | v22.22.2 |
| Provider | `anthropic-oauth` (Claude subscription, not API-key billing) |
| Cluster | `org-local` kind, single control-plane node |
| Policy generation | `ctx-1/exec-1`, decision engine `dec-1` (single generation throughout) |
| Total real spend | ≈ $24.6 across all three tiers (smoke $0.27, population $8.39, regimes $21.4) |
| Total real dispatches | 62 (2 smoke + 14 population + 48 regime, 2 of which were retries of environment failures) |

## 2. Aggregate table — regime suite (the largest, most varied sample)

| Metric | Baseline | Full | Delta | Interpretation |
|---|---:|---:|---:|---|
| Tokens / successful task | 5,826 | 8,549 | **+46.7%** | regression |
| Success rate (outcome=success) | 0.875 (21/24) | 0.792 (19/24) | **-9.5%** | regression |
| Turns / success | 18.23 | 25.83 | **+41.7%** | regression |
| p95 latency | 570,283 ms | 748,837 ms | **+31.3%** | regression, past 25% tolerance |
| Cost / success (raw) | $0.453 | $0.496 | +9.4% | regression |
| Orchestration overhead | 0.00% | 1.88% | within 5% bar |
| Tasks stopped by guard | 0 | 1 | Full's guard killed a task Baseline completed |
| Quality | not scored | not scored | inconclusive |

**Harness verdict: `regressed`** — tokens/success didn't fall, success rate
fell more than the 0.02 epsilon, p95 latency rose past tolerance.

## 3. Regime results

| Regime | On success | Off success | On tokens/success | Off tokens/success | Verdict |
|---|---:|---:|---:|---:|---|
| information-rich | 3/3 | 3/3 | 4,121 | 1,487 | **regressed** (+177%, latency +133%) |
| information-poor | 3/3 | 2/3 | 11,312 | 14,565 | inconclusive (quality unscored; Baseline's own failure muddies its bar) |
| hidden-dependency | 3/3 | 3/3 | 6,400 | 5,789 | **regressed** (+10.5%, latency +64%) |
| exploration-trap | 3/3 | 2/3 | 8,027 | 6,061 | **regressed** (+32.4%, latency +524%*) |
| strategy-failure | 2/3 | 3/3 | 14,988 | 6,903 | **regressed** (+117%, success rate fell, guard stopped a task Baseline won) |
| hard-budget | 3/3 | 3/3 | 16,718 | 6,546 | **regressed** (+155%, more than double the turns for the same successes) |
| shared-information | 3/3 | 3/3 | 6,758 | 3,395 | **regressed** (+99%) |
| novel | 3/3 | 3/3 | 9,630 | 5,095 | **regressed** (+89%, latency +101%) |

\* `exploration-trap`'s 524% latency figure is partly an artifact: Baseline's
`trap-broad-review` failed early (16 turns) rather than running to completion,
so the comparison isn't apples-to-apples on that one goal. Flagged, not hidden.

**Zero regimes show a win.** One is inconclusive only because Baseline also had
a failure in it, not because Full pulled ahead.

## 4. Critical harness defect — no repository isolation

**The harness has no isolation of the repository working tree between goals or
between arms.** Every dispatch (`org run`) executes directly against this live
working directory (visible in every dispatch as `Operating on:
/home/abhay06102003/Desktop/CherryOnTop`), with no git worktree, fork, or reset
between goals. `bench/README.md`'s isolation section (§9 of the plan) covers
DB path, port, and daemon identity — it does not mention the repository tree,
and this run found out why that matters.

After the regime suite finished, `git status` showed **85 files touched, 463
insertions / 140 deletions, zero new commits** — real, uncommitted edits left
by the 48 regime dispatches, piled on top of each other. Concretely:

- The **on** arm ran all 24 goals first, mutating the tree the whole time
  (e.g. `hidden-schema-consumer` really added a `supersededBy` column to
  `src/db/schema.ts`; `shared-parallel-docs` really wrote three READMEs).
- The **off** (Baseline) arm then started **against that already-mutated
  tree**, not against the frozen `e088eae` commit. The harness's own
  reproducibility metadata still reported `repositoryRevision: e088eae` for
  both arms — correct for the HEAD hash, misleading for what was actually on
  disk, because a dirty working tree doesn't change HEAD.
- Within a single arm, later goals could see (and in some cases plausibly
  built on top of) earlier goals' edits to the same files — `tokens.ts`,
  `src/config/efficiency.ts`, and several `src/db/queries/*.ts` files were
  each targeted by 2–3 different goals across the suite.

This is a direct violation of the plan's own Invariant #1 ("same repository
revision... for matched runs") that nothing in the existing harness would have
caught — `validateMetadata` only diffs commit hashes and a single
whole-invocation dirty flag, not per-goal tree state. **This does not
necessarily reverse the regression direction reported above** — the pattern
was broad and one-sided across regimes designed to probe unrelated mechanisms,
which is some evidence it reflects the architecture rather than tree drift —
but it does mean every magnitude in §2–3 should be read as *softer* than the
numbers imply, and this must be fixed (isolated worktree per goal, or a
git-clean/reset between every single dispatch) before Phase 2 or any
tuning decision is made from this data.

The dirty tree was discarded (`git reset --hard e088eae` + `git clean -fd`,
excluding this report and the raw `bench/` artifacts) rather than left in the
repository.

## 5. Environment failures — real, and excluded correctly

Per the benchmark protocol (§9, §25.6): environment failures are retried and
excluded from the product comparison, not folded into a "regression."

1. **Auth expiry**, mid on-arm regime run (`org doctor`: *"Your Claude login
   expired at 15/9/2026, 3:59:07pm"*). Caused 16 consecutive zero-cost,
   1–2-turn `FAILED` rows on the on-arm. User re-ran `claude login`; the 16
   goals were re-dispatched cleanly afterward. None of the 16 original rows
   are in the reported data.
2. **5-hour usage-window exhaustion**, mid off-arm regime run. Confirmed from
   the node's own event log: `exec.rate_limit_event` with
   `"five_hour":{"utilization":1}` and the assistant message *"You've hit your
   session limit · resets 8:40am (UTC)."* Caused 14 consecutive zero-cost
   `FAILED` rows on the off-arm. Waited for the window to reset (confirmed via
   `org doctor`), re-dispatched cleanly. None of the 14 original rows are in
   the reported data.
3. **A single rate-limit retry** during the frozen-population run
   (`small-bug`, off-arm) succeeded on retry but produced an anomalous
   telemetry row: **$2.0006 for 4 turns and 1,960 total tokens** — roughly
   1,000x the $/token ratio of every other one of the 14 population dispatches.
   This is flagged as a probable billing/telemetry defect, not excluded,
   because it's a real dispatch that really completed — but it should not be
   trusted at face value, and it is the main reason the frozen-population
   (n=7) comparison was noisy in both directions. **Recommend filing this as
   its own investigation** before relying on any $-based metric from a
   rate-limit-recovered dispatch.

Two more failures are genuine **product** failures, kept in the data:
`strategy-wrong-layer` (on-arm, real spend $0.83/32 turns, real failure) and
`poor-vague-improvement` + `trap-broad-review` (off-arm, real spend $0.94/36
turns and $0.41/16 turns).

## 6. What this does and does not establish

**Does:**
- Across 8 economically-distinct regimes deliberately designed to probe the
  architecture's specific claimed mechanisms, Full Architecture did not win
  any of them on the plan's own acceptance contract.
- The regressions are concentrated exactly where the architecture claims the
  most value: `hard-budget` (dynamic resource allocation) and
  `strategy-failure` (evidence-preserving recovery) are the two worst
  regressions by percentage, and `strategy-failure` is also where the
  economic guard actively stopped a task the baseline completed successfully.
- `information-rich` — the "easy" regime, where extra context should be
  recognized as pure waste — regressed hardest in relative terms (+177%
  tokens/success), which is the opposite of the architecture's stated thesis.

**Does not:**
- Prove Baseline's *answers* were better. No rubric was hand-scored on any of
  the 48 regime dispatches. The plan's quality floor cannot be checked, in
  either direction, from this data alone.
- Generalize beyond n=3 per regime. This is Phase-1 smoke scale for the
  regime suite specifically (the plan's own Phase 2 asks for 8–12 per regime).
  A regime showing a 10% regression on 3 tasks is a direction, not a
  magnitude — a regime showing 155% is a stronger direction but still one
  data point per goal.
- Rule out the same context-selection confound named in the original
  `n=1` report: `ORG_EFFICIENCY_MODE` still gates context selection, model
  routing, and the economic control plane together. The regime suite result
  is broader and more consistent than the earlier confound allowed for, but it
  is still one switch, not an isolated economic-layer measurement.

## 7. Recommended next step

Per the plan's tuning protocol (§28): this is now enough signal to justify
**one** mechanism hypothesis, not a rewrite. The two most attributable
candidates, in order:

1. **`hard-budget`**: turns more than doubled (61 → 146) for the same success
   count. Look at `decision/orchestration-loop.ts` (cadence/backoff) and
   `efficiency/task-economics.ts` (allocation) — the architecture is spending
   turns, not tokens-per-turn, and turns are what the plan says costs
   superlinearly.
2. **`strategy-failure`**: the guard stopped a task Baseline won. Look at
   `recovery/engine.ts` and `decision/trust.ts` — a false-positive intervention
   by the compareArms definition (`full.tasksStopped > baseline.tasksStopped`).

Do **not** tune from `information-rich` alone (n=3, small absolute dollars) or
from the anomalous $2.00 telemetry row. Any regression test written from this
data should assert against `hard-budget`'s turn count and `strategy-failure`'s
stop count specifically, per §28's rule against tuning from aggregate tokens
alone.

## 8. Raw data

- [bench/econ-smoke-2.json](../../bench/econ-smoke-2.json) — smoke pair, post-fix
- [bench/econ-full.json](../../bench/econ-full.json) — frozen population, n=7
- [bench/regime-on.jsonl](../../bench/regime-on.jsonl) / [bench/regime-off.jsonl](../../bench/regime-off.jsonl) — regime suite raw dispatch rows, 24 each
- [bench/regime-result.json](../../bench/regime-result.json) — full regime comparison, per-regime and per-goal
- [bench/regime-runner.mjs](../../bench/regime-runner.mjs) — streaming per-goal harness runner written for this run (each goal flushed to disk immediately; survives a killed process or an expired token without losing completed work)

## 9. Final verdict

**Regression.**

Tokens per successful task rose, success rate fell, p95 latency rose past
tolerance, and the harness's own acceptance contract failed in 7 of 8 regimes
with zero wins. This is not decisive at n=3-per-regime, and quality was never
scored — so it is reported as a regression under the measured conditions, with
the explicit caveat that a Phase-2-scale rerun (8–12 tasks/regime) and a real
quality rubric are what the plan requires before this becomes a shipping
decision either way.
