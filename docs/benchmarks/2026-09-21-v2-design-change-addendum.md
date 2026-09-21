# Design change addendum -- direct arm dropped in favor of published baselines

Filed after the pre-registration commit (`ec2f2a3`) and after two smoke
dispatches had already run, per the pre-registration's own rule: "If you
later change an endpoint, say so explicitly and label the new one
exploratory." This file is the explicit statement; nothing in
`2026-09-21-v2-pre-registration.md` is edited retroactively.

## What changed

The user directed, mid-run: do not self-run `claude --print` as the
"direct-sonnet5" arm. Instead, use each benchmark's own published/platform
leaderboard figure for Claude Sonnet 5 as the comparison point.

This directly overrides `PUBLIC-BENCHMARK-PROMPT-V2.md` §0.2 ("The direct
arm is run by us, not cited"), which argues at length against exactly this
substitution -- its stated reason is that a published aggregate cannot be
paired instance-by-instance with a self-run arm, which the primary McNemar
exact test and the paired Wilcoxon cost test both require. That objection
was raised to the user directly, quoting the doc, before making this
change; the user confirmed the platform-numbers design regardless.

## Consequence for the statistical framework

The pre-registered primary endpoint (McNemar exact on discordant
CherryOnTop/direct pairs) and secondary A (paired Wilcoxon on cost) are
**no longer computable as designed** -- there is no per-instance direct-arm
outcome to pair against. This is now a **single-arm study with published
external context**, not a paired harness comparison. Concretely:

- CherryOnTop is run (self-run, as originally planned) on all 6
  pre-registered tasks (4 Tier A + 2 Tier B), plus the 1 Tier A smoke
  instance.
- Resolve rate and Wilson 95% CI are reported for CherryOnTop alone, per
  tier.
- The comparison point is each benchmark's own published Claude Sonnet 5
  score (SWE-bench Verified: 85.2%, Claude Sonnet 5 System Card §8.2;
  Terminal-Bench: 80.4%, §8.3 -- both already gathered and cited in
  `bench/tier-b/tasks.json` and this addendum), reported as **context, not
  a head-to-head**, per hard rule 2 ("No head-to-head claim against any
  agent you did not run") -- which still applies and is *more* load-bearing
  under this design, not less, since there is no paired run to fall back
  on if a reader mistakes the comparison for one.
- No McNemar p-value, no paired cost Wilcoxon, no discordant-pairs table.
  The verdict table in §9 of the source doc (DIRECTIONAL/LOSS/INCONCLUSIVE,
  built entirely on the paired McNemar gate) does not apply to this design
  and is not used. The final report states a plain descriptive result
  instead: CherryOnTop's own resolve rate and cost, with the published
  figure alongside for scale, and an explicit reminder of why the two are
  not statistically comparable (different instance sets: our 6 vs. the
  full 500/89; different sample sizes; no shared randomization).

## What is NOT reused

Two direct-arm dispatches had already run before this instruction landed:

- Tier A smoke (`pydata__xarray-6461`, direct arm): COMPLETE, $0.69, 144s,
  25 turns -- real data, but the arm it belongs to is no longer part of the
  study design. Recorded in `bench/swebench/results/smoke-v2.jsonl` and
  disclosed in the report as collected-then-superseded, not deleted.
- Tier B smoke (`cargo-flight-dispatch`, direct arm): killed mid-dispatch
  (SIGTERM) once this instruction landed, after ~228s and $1.01 of
  estimated token usage. Recorded in `bench/tier-b/results/smoke-main.jsonl`
  with `state: "FAILED"` -- this is an artifact of the kill, not a real
  failed attempt, and is excluded from any table that implies the direct
  arm was actually evaluated.

Neither row is used in the final resolve-rate or cost numbers. Both are
listed in the report's validity section as excluded-with-reason, per the
"only VALID rows enter statistics" rule, which still applies.

## Published Sonnet 5 baselines used as context (verified against primary
sources, not secondary aggregators)

| Benchmark | Score | Harness | Source | Date |
|---|---|---|---|---|
| SWE-bench Verified | 85.2% (avg. of 5 trials) | Anthropic's internal standard config, adaptive thinking at max effort | Claude Sonnet 5 System Card §8.2, p.116 | 2026-06-30 |
| Terminal-Bench 2.1 | 80.4% mean reward (avg. of 5 attempts x 89 tasks, 445 trials) | mini-SWE-agent, GKE cluster, xhigh effort | Claude Sonnet 5 System Card §8.3, p.116-117 | 2026-06-30 |

Both pulled from the primary-source PDF (`www-cdn.anthropic.com/.../Claude
Sonnet 5 System Card.pdf`), not from secondary aggregator sites -- one of
which was checked during task selection and found to state a Terminal-Bench
figure the actual Anthropic announcement page does not contain, which is
why the system card PDF was fetched and read directly instead of trusting
the aggregator.
