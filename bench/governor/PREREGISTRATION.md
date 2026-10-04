# Economic Governor benchmark — pre-registration

Written and frozen (git tag `governor-bench-prereg`) **before any benchmark run**.
Nothing below may change after the first result is seen; any change starts a new
benchmark generation with a new fingerprint.

## Why two arms

Production calls the governor only at *dispatch boundaries* (before a dispatch is
built, and before each retry). Inside a dispatch the CLI agent runs fully autonomously.
On single-dispatch coding tasks that means one look, and the 2026-10-01 pilot showed
that look fails closed (`missing_telemetry`, orchestration confidence 0 before any
action). A real-model benchmark of H0–H4 can therefore only measure **overhead,
quality preservation and dormancy** — not the mechanisms.

So the protocol runs in two arms:

* **Arm A — simulated agent world (primary for mechanism questions).** The *real
  compiled governor* (`dist/`) governs a stochastic agent at **per-step boundaries** —
  the plan's target architecture, where the autonomy horizon is measured in tool
  actions. The state the governor sees is built with the same formulas
  `economicStateFor` uses (same uncertainty mapping, same `compareTrajectory`, same
  `allocateBudget` reserve, same recovery source). Ground truth (latent failure modes,
  true intervention effects) is never visible to the governor.
* **Arm B — real model (secondary; dormancy/overhead/quality).** H0 vs H4 on real
  SWE-bench tasks with the production boundary, using the existing pilot harness.

Arm A results are claims about the controller's logic under a stated world model,
not about real agents. Arm B is the reality check.

## Arm A world model (fixed)

All parameters are in `config.json` (frozen with this file). Summary:

* Buckets: local, multi-file, exploratory, risky/validation-sensitive; long-horizon is a
  cross-cutting 25 % tag (×1.8 steps).
* Each task has 0–3 latent failure modes `{dim, onset, lag, hidden, special, severity}`.
  A mode is silent until detected (a failing check `lag` steps after onset), may be
  self-caught by the agent, causes rework proportional to steps since onset × severity
  × (1 + ½ commitment), and is a hidden failure (passes validation, fails ground truth)
  with a bucket-dependent probability.
* Observable precursor: active structural/behavioural modes make the agent repeat
  searches ("flail") with a bucket-dependent probability.
* Intervention ground truth (`trueEffects` in config): what each intervention family
  actually prevents/detects/saves and costs. Governor-declared priors deliberately
  differ from truth (e.g. read-design declares 0.5, true 0.3).
* Production carry-out semantics are mirrored exactly: `deep:validate` and
  `deep:constrain` are recorded but **not carried out** (as in production); `recover`,
  context reads, historical reuse and governor advice are carried out. Advice is
  followed with probability 0.85.
* "Special" modes model candidate-generation gaps: only `dormant:inspect-dependents`
  or the agent's own proposal can prevent them.
* Common random numbers: every exogenous draw is a hash of (task seed, rep, stream,
  step, index), so variants are paired.

## Variants

H0 (no governor), H1 (current market), H2 (+risk, option), H3a (+discovery,
proposals, dormant pool), H3b (+composition), H3+AH (+adaptive horizon), H4 (+learning:
packets→misses→ladder→causal memory, motifs, calibration). H4 runs in M2 (warm causal,
chronological). Memory study: H4 under M0/M1/M2, H1 under M0/M1.

## Passes and sizes

* Pass A (rapid): 24 tasks (6/bucket) × 3 reps × all variants.
* Pass B (confirmatory): 120 tasks (30/bucket) × 3 reps × all variants + memory regimes.
* Chronological learning split for M2: tasks 1–48 train, 49–72 adaptation, 73–120
  held-out (memory frozen in the held-out window; each held-out task is evaluated
  before anything about it could update memory).
* Stress sets (20 tasks × 3 reps, H0/H1/H3/H4): easy, long, candidate-generation,
  near-miss, unavoidable, over-intervention, novelty.

## Metrics (definitions fixed)

* Primary: CPS = total tokens / ground-truth successes (USD at $3/M tokens); also
  tokens/task, latency/success. Quality: ground-truth success, validated success,
  hidden-failure rate, recovery-required rate.
* Agenticity: autonomy ratio = steps without a carried-out intervention / steps;
  interventions/task; intervention rate; zero-intervention task share; mean/median
  autonomy horizon (adaptive variants); strategy novelty = agent proposals accepted.
* Governor economics: governor overhead ratio = (intervention tokens + disruption +
  discovery tokens + replay tokens) / total tokens; market latency; packet bytes.
* Prevention: prevention debt (ground truth: rework tokens from modes a feasible true-
  useful intervention could have prevented before onset), confirmed miss rate,
  near-miss count, intervention regret (oracle counterfactual by masked re-run).
* Candidate space: OpportunityRecall@1/@3/@5 vs an analytic oracle; candidate-
  generation miss rate; discovery trigger rate and tokens.
* Learning: Brier/ECE of the governor's failure probability, motif count, M0→M2 CPS.

## Statistics (fixed)

Per variant: mean, median, IQR. Paired comparisons at task level (reps averaged)
against H0 and the preceding layer. 95 % CIs by paired bootstrap over tasks (2,000
resamples, seed 20261002); CPS deltas are ratios of sums recomputed per resample.
Success differences: paired difference with bootstrap CI and a run-level 2×2
contingency. No metric is dropped or added after results are seen.

## Decision rules (fixed)

A mechanism is **retained** if its incremental comparison shows lower CPS with the CPS-
delta CI below 0 and no success regression whose CI lies entirely below −2 pp;
**gate more aggressively** if CPS is flat (CI spans 0) but overhead > 1 % of tokens;
**modify** if it improves one primary metric and worsens the other; **remove** if CPS
is worse with CI above 0 or success regresses (CI below −2 pp).

## Arm B schedule (fixed before launch)

`bench/governor/real/`: 5 SWE-bench Verified instances (flask-5014, sympy-17139,
seaborn-3187, requests-1142, sphinx-9698) × {H0, H4} × 2 reps = 20 runs, Haiku 4.5
pinned for every role, $5 cap, 80 execute turns, 45-minute timeout, System-1 (Laya) on
as in production. Same build for both arms; only `ORG_GOVERNOR_ABLATION` differs.
Order per task H0, H4, H4, H0, dealt onto 2 lanes. Graded with the official SWE-bench
harness. Reported: resolved rate, cost/run, cost per resolved, turns, boundary looks,
interventions, packets, governor events, and any run where the arms' behaviour differs
for a reason the governor can be blamed for. n is small: Arm B is a dormancy/overhead/
quality check, not a powered comparison.
