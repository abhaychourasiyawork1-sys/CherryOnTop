# H2.6 — randomized recover-eligibility experiment

Status: **design draft. Nothing here is implemented, and no assignment has
been or may be drawn.**

The tag `h26-prereg` is created only after the implementation, its tests, a
code review and the exact experiment configuration (including the seed
commitment) are all committed (§12). The runtime refuses to draw an assignment
from any build that does not pass the tagged-build invariant (§4). Runtime
learning stays off throughout (§10), and H2.5 production policy is unchanged.

## 0. Question and scope

H2.5 (H2 risk pricing + the feasibility filter) is the operating point.
Observational value learning was confounded ~38× and self-locked
(`offline/learned-*.mjs`). Short-horizon outcomes were not valid value proxies
in the Arm A world (`offline/proximal.mjs`). Withhold-only randomization was
the only unbiased estimator tested.

**Question.** At the first point in a task where recover could be offered,
does *making it available to the market* change the task's cost-to-go,
compared with withholding it at that point?

This is an **eligibility** question. The design does not estimate the effect
of executing recover (§3).

**On the planning numbers.** The effect size d = 0.073 and N_max = 3,035
triggered tasks per arm come from the Arm A *simulation*, a world model whose
effect tables were written by hand. They are used to size the design. They
are **not** an assumption, prediction or prior that real agents will show the
same effect. The real effect may be larger, smaller, zero, or of the opposite
sign. The design's error rates do not depend on the planning value; only its
power does. How the type-I error behaves under skewed outcomes is measured in
§13.

## 1. Causal diagram

```
                 U  (latent task difficulty, failure mode, agent state)
          ┌──────┼──────────────┬────────────────────┬──────────┐
          ▼      ▼              ▼                    ▼          ▼
  S ──► W      M*  market  ──►  E*  execution  ──►  L  later  ──►  Y  task
  │ (would-  ▲  choice at b*    at b* (recover      boundaries    cost-to-go
  │  select) │  {recover,       carried out, a      (recover      (+ resolution,
  │          │   substitute,    substitute, or      available     the safety
  │          │   continue}      nothing)            in both arms, endpoint)
  │          │                                      not manipulated)  ▲
  └──────────┴──────────────────────────────────────────────────────┘
             ▲
  Z ──► A ───┘
 coin   recover available at b* (A = 1 − masked)
```

* **Z** is the randomized mask, an HMAC assignment (§4). It is independent of
  U and S by construction. **A** is recover's availability at b\*;
  Z → A is deterministic. Z acts **only at b\***.
* **S** is the unmasked state and candidate snapshot at b\*. **W** = f(S) is
  whether the unmasked market would select recover. Both are *computed* before
  Z, and both are recomputable from the logged snapshot digest: they are
  pre-assignment. They are persisted together with Z in one immutable record
  (§4).
* **M\*** and **E\*** are the market's choice and the execution at b\*. **L** is
  every later boundary, where recover is available in both arms. All three are
  endogenous: U affects them.
* **Identified:** Z → Y (E1), Z → Y within the strata of W (E1′), and the
  effects of Z on M\*, on E\* and on L (substitution at b\*, later recovers).
* **Not identified:** E\* → Y. U confounds it, and Z reaches Y through
  substitution at b\* and through later recovers.

## 2. Preconditions — dormancy fixes (specified, not implemented)

Evidence: Arm B (20 runs) and `h26/survey-real.cjs` over every preserved
real-run database (39 databases, 50 agent nodes). It found 37 economic
decisions, 27 refused with `fault:missing_telemetry`. 13 nodes failed
validation, 7 retried, and 2 retries reached the economic boundary. Recover
was a candidate once, chosen 0 times and carried out 0 times.

### D1 — separate *governor-observable* from *intervention-eligible*

The first boundary runs before any agent action:
`orchestrationConfidence = min(goal confidence, actions / 5) = 0`, so
`detectFaults` emits `missing_telemetry` and every intervention is refused.
The fix keeps exactly that refusal. It only makes the boundary observable:

* **observable(boundary)** — true at every evaluated boundary, including the
  first. The governor records a decision packet, the risk snapshot and the
  coverage, and the market may choose `continue`.
* **interventionEligible(boundary)** — at least one recorded agent action and
  `orchestrationConfidence > 0` from the run's own trace. When it is false,
  interventions are refused as today, recorded once as
  `ineligible:no_telemetry`.
* **recoverEligible(boundary)** — additionally requires a failure signature
  from a *completed* dispatch and a recover candidate that `evaluateRecovery`
  justified. Recover is therefore never offered at the first boundary.

### D2 — a task-level turn budget with an explicit retry reservation

The first dispatch could consume the whole task turn cap. The retry was then
hard-stopped by the spend guard before the boundary ran (`g-T3-H4-r1`: "Turn
cap reached — 82 of 80 turns").

Budgeting policy, **identical in every arm** (H0, H2, H2.5, and both
experiment arms). It is an environment parameter of the benchmark generation:

* **T** — the task turn budget (`ORG_MAX_TURNS_EXECUTE`; 80 in the pilot).
* **R** — the retry reservation, `R = ⌈0.25 · T⌉` (20).
* **Dispatch 1 cap:** `T − R`. **Dispatch k ≥ 2 cap:** all turns left.
  Turns are counted per node. Turns that node spent before its first execute
  dispatch (normally none) come out of dispatch 1's share, so the cap is
  `T − R − used` and R always survives for the retry.
* The spend guard's turn check uses the task total T. A retry with reserved
  turns left passes the guard. Exhausting T still stops hard.
* Whether a retry happens is decided by the lifecycle (validation failed and
  turns remain), by the same rule in both experiment arms. Masking acts only on
  the market's menu at b\*, never on the turn budget or on whether a retry
  exists. Recover masking therefore cannot be confounded with turn budgets.
* **Turns are model turns.** Claude Code honours `--max-turns n` exactly (n
  model calls) but reports `num_turns = n + 1` when it stops on the cap
  (`error_max_turns`; on success the two agree). The runtime records the model
  calls actually made, so dispatch 1 runs at most T − R turns and the retry
  sees all of R. This is a measurement fix and applies to every arm.
* **D2 reserves turns, not budget (resolved 2026-10-03).** The retry still
  passes the market's ordinary commitment check, identical in every arm: its
  reservation must fit the task's turn-scaled token budget
  (`max(consumed, T · measured tokens/turn)`, input + output tokens, no cache
  reads) and the USD authority. A retry refused there stops the task before
  its execution boundary is evaluated, so it never reaches b\* and is never
  assigned. The refusal acts before Z and cannot differ by arm; it thins the
  §8 funnel, which the pilot measures. Reserving token headroom as well would
  change the H2.5 market's reservation policy and is out of scope.

D1 and D2 change H0 too, so every arm runs on a new benchmark generation. The
v1 Arm B numbers are not comparable to it.

**One production bug fix ships with D1/D2 and applies to every arm,
experiment on or off.** The System-1 re-choice at an execution boundary now
sees only candidates the market left available. Before, it could re-pick a
candidate the market had refused as `unavailable:*` (e.g. the H2.5
feasibility filter's `not_carried_out`), which the masking guarantee could not
tolerate. With nothing refused, the menu is unchanged, so H2.5 behaviour
differs only where System-1 used to override a refusal.

**Funnel counts** (§8, and the engineering validation) are defined on logged
events: a *boundary* is one `economic.decision` event; *observable* is one
that decided (not `not_due` or `reentrant`); *interventionEligible* is an
observable one without `ineligible:no_telemetry`; a *recover-candidate
boundary* is an evaluated boundary with a recover candidate on its menu (each
logs either the assignment or an `experiment.boundary` row).

## 3. Estimands

**Unit:** a task (a root node).

**b\*:** the task's first recover-eligible boundary. Only b\* is manipulated.

**Population:** triggered tasks, those that reach b\*. Masking cannot act
before b\* — the two arms are one process until then — so "triggered" is a
pre-treatment event.

* **E1 — the ITT eligibility effect (primary).**
  `E1 = E[Y | Z = available, triggered] − E[Y | Z = masked, triggered]`.
  It is the effect of recover's availability *at b\** on cost-to-go, including
  everything downstream: substitution at b\* and recovers at later
  boundaries, which are available in both arms.
* **E1′ — the would-select subgroup effect (secondary).** W = 1 if, in the
  unmasked priced snapshot at b\*, recover is first in the market's own order
  over all feasible candidates including `continue`. That order is
  conservative cost, then expected cost, then confidence, then id.
  W is computed before Z is computed, from the unmasked pricing alone, and is
  recomputable from the logged snapshot digest (§4).
  `E1′ = E[Y | Z = available, W = 1] − E[Y | Z = masked, W = 1]`.
  It is an ITT within a pre-assignment stratum. Observed post-assignment
  selection is never conditioned on.
* **Mediator effects (identified, descriptive):** the effect of Z on:
  P(M\* = recover); P(E\* = recover carried out); P(M\* = a substitute, i.e.
  any choice other than recover or continue); P(recover carried out at any
  later boundary).
* **Not estimated:** any execution effect of recover. No ITT is divided by a
  selection or carry-out rate. The exclusion restriction such a ratio needs —
  Z affects Y only through recover's own execution at b\* — is expected to fail
  through substitution and later recovers, and is not assumed.

## 4. Assignment

**Key and commitment.** Before the tag:

1. The operator generates a 256-bit key: `openssl rand -hex 32`.
2. The key is stored outside the repository, at the path in
   `ORG_EXPERIMENT_KEY_FILE`, mode 0600.
3. Only its commitment, `keyCommitment = SHA-256(hex-decoded key)` in
   lowercase hex, is written into `h26/config.json` and frozen by the tag.
4. The key is revealed (committed to the repository) only after the final
   analysis, so anyone can recompute every assignment.

**Tagged-build invariant.** `h26-prereg` is an *annotated* tag. Its message
records, as `name = lowercase hex`:
* `configSha256` = SHA-256 of `bench/governor/h26/config.json`;
* `lockfileSha256` = SHA-256 of `package-lock.json`;
* `installedTreeSha256` = SHA-256 of `node_modules/.package-lock.json` after
  `npm ci`;
* `buildFingerprint` = SHA-256 over the sorted list of
  `(path relative to dist/, SHA-256 of the file)` for every file under `dist/`
  produced by `npm ci && npm run build` at the tagged commit, followed by the
  Node.js version string;
* `keyCommitment` (the same value as in the config).

At start-up, and again before every assignment, the runtime assigns only if
**all** of these hold. Otherwise it refuses, logs `refused:<check>`, and the
boundary proceeds unmasked with the task not enrolled:
1. `HEAD` is exactly the commit `h26-prereg^{commit}`;
2. the working tree is clean (`git status --porcelain --untracked-files=all`
   is empty);
3. SHA-256 of the config equals `configSha256`;
4. the lockfile hash and the installed-tree hash equal `lockfileSha256` and
   `installedTreeSha256`;
5. the recomputed `dist/` fingerprint equals `buildFingerprint`;
6. `SHA-256(key) == keyCommitment`, with the key read from
   `ORG_EXPERIMENT_KEY_FILE`.

The key is never in git before the final analysis. Only its commitment is,
inside the config and the tag message.

**Assignment function.** For a task with root node id `τ`, created at
submission and therefore fixed before b\*:

```
h(τ)   = HMAC-SHA256(key, "h26-recover-eligibility-v1" ‖ 0x00 ‖ τ)
u(τ)   = (first 8 bytes of h(τ), big-endian unsigned) / 2^64      ∈ [0, 1)
Z(τ)   = masked     if u(τ) < ε
         available  otherwise
ε      = 0.5
```

* Without the key, Z cannot be predicted from the task id. With it, any
  assignment can be audited. There is no shared counter, so concurrent lanes
  cannot race.
* ε = 0.5 is fixed. If the pilot feasibility gate (§8) fails, the experiment is
  not run. ε is not re-tuned; that would be a new pre-registration.
* Z is computed once, at b\*, and only for triggered tasks. Tasks that never
  reach b\* are never assigned. A task the tagged-build invariant refused is
  not enrolled. That refusal is independent of Z, because it happens before
  Z is computed.

**Order of operations at b\*:**

1. Build the unmasked candidate set and check the §5 rules.
2. Price the set once, with `chooseEconomicAction`'s funnel and no masking.
   Compute `snapshotDigest` = SHA-256 of the canonical JSON of the priced,
   unmasked candidate snapshots.
3. Compute W, recover's rank among feasible candidates, and its margin
   (continue's conservative cost − recover's), from that pricing alone.
4. Compute u(τ) and Z(τ).
5. Persist **one** `experiment.assignment` record, complete and immutable, in
   a single database transaction. Insert-only, with a unique key on
   (experimentId, phase, rootTaskId). The record lives in the **experiment
   ledger** (`ORG_EXPERIMENT_LEDGER`), one SQLite file shared by every run of
   the experiment, separate from each run's own database; triggers refuse
   UPDATE and DELETE. The ledger also holds the masked count the C_mask guard
   reads and every assignment-integrity stop, so both apply across runs.
   A copy of the record is appended to the run's event stream after the
   commit. It contains every §9 assignment field:
   task identifiers, the snapshot digest, W, rank, margin, the HMAC message,
   u, Z, ε, and the build and config fingerprints. No partial row is ever
   written, and no row is ever updated.
6. Only after the transaction commits: if Z = masked, every recover candidate
   (alone or inside a composite) is refused on that pricing with
   `unavailable:experiment:masked`, and the market chooses over the rest. The
   same refusal filters the menu System-1 may re-choose from at that boundary.

Crash and failure handling:
* A crash before step 5 commits leaves no record. The next evaluation of the
  same boundary recomputes the identical record, since every input is
  deterministic.
* A crash after commit leaves the complete record. When the same boundary
  (node and state version) is evaluated again, the stored record is the
  assignment and its Z is always honoured; no second record is written. The
  re-evaluation compares the **assignment identity** (experimentId, phase,
  rootTaskId, boundary, tag, HMAC message, u, Z, build fingerprint) with the
  stored record. A difference is a fatal integrity error: assignment stops (an
  unscheduled operational stop, §7). The re-priced menu is not compared:
  in-memory trajectory and risk state are rebuilt after a restart, so pricing
  need not repeat exactly, and the stored W, rank, margin and snapshot stay
  the ones logged before Z.
* If the write fails, there is no valid atomic record, so the task is **not
  enrolled**:
  * no mask is applied, and the task continues normally outside the
    experiment;
  * it has no valid Z for the ITT analysis, and never enters the main
    analysis set (§6). Z is not recomputed for it after the fact;
  * the failure is logged with τ to a separate `experiment.write_failure`
    stream;
  * all further assignment stops: an assignment integrity failure, which is an
    unscheduled operational stop (§7).

  Pilot integration criterion 7 requires zero such failures.

**Masking only removes** recover at b\* before the market chooses. It never
forces recover or any other action, and never touches `continue`.
`chooseEconomicAction` stays the sole chooser. At every boundary after b\*,
recover is unmasked in both arms. Later recover candidates are logged
(`experiment.boundary`), never manipulated.

## 5. Eligibility and safety restrictions

A recover candidate at a boundary is **recover-eligible** only if all of the
following hold. The first boundary where they all hold is b\*. A boundary
failing a rule is logged `excluded:<rule>`, and recover stays available there
in both arms.

| Rule | Operational check |
|---|---|
| intervention-eligible | D1's `interventionEligible` |
| a real retry | a failure signature from a completed dispatch; `evaluateRecovery` justified |
| executable | `isExecutable(candidate)` |
| reversible | the carry-out changes no workspace state (`carryOutRecovery` writes a tombstone and guidance text only). The contract `reversibility` (`1 − expectedProgress`) is not used: it is below 1 for every recover |
| never under a hard stop | `!state.constraints.hardStop` and no hard spend-guard stop |
| never in an irreversible state | `commitmentDepth(state) < 0.5` |
| never the sole required validation path | not when masking would leave no feasible candidate leading to a required validation |
| masked-task budget guard | at most C_mask = 3,400 masked main-phase tasks (§7, Enrollment) |

Each task is manipulated at most once, at b\*.

Operator kill switch: `ORG_EXPERIMENT=off` prevents new assignments for
subsequently started experiment tasks; an in-flight task is not interrupted.
The variable is read when a daemon starts, so a run already under way keeps
the setting it started with, and may still be assigned if it has not yet
reached b\*. The operator sets it and starts no further runs (the scheduler
is relaunched with it). Every recover candidate a killed run meets is logged
`refused:kill_switch`. It is an unscheduled operational stop (§7) and never produces an
efficacy conclusion. Assigned tasks keep their logged Z, and the analysis is
by assignment (intention to treat).

## 6. Outcomes

* **Primary causal outcome, Y:** mean task-level cost-to-go from b\*, in USD at
  the price snapshot pinned in `h26/config.json` (cache-aware):
  `Y = C(b* → end) + 𝟙[not resolved] · C(task)`.
  * `C(b* → end)` is every role's cost from b\* to task end, including
    governor, intervention and carry-out tokens.
  * `C(task)` is the whole task's cost: a failed task is priced as a redo.
  * "Resolved" is the official SWE-bench grade, joined offline.
* **Analysis set (ITT):** every main-phase task with an `experiment.assignment`
  record, analysed by its recorded Z, whatever happened afterwards. Nothing
  observed after assignment removes a task from the set. A run that times out,
  errors or is cancelled is an outcome (unresolved, its cost counted), not a
  missing value. The only missing value is a grade the official harness
  failed to produce. Such a task is re-graded up to 3 times. If still
  ungraded, Y is computed with resolved = false (the conservative redo
  penalty). The missing-grade rate is reported per arm, and a
  complete-case analysis is a pre-declared sensitivity only.
* **Provider refusals are invalid runs, not outcomes.** A run in which the
  model provider refused service (a `rate_limit_event` with status
  `rejected`, the runtime's "usage limit is used up" message, the market's
  `harness_rate_limited`, or a final unrecovered API rate-limit/overload
  error) measured the account's quota, not the task. It is marked invalid,
  kept on disk, and excluded from every analysis; the scheduler halts at the
  first one. Invalid counts are reported per arm, and for any invalid task
  that had already been assigned, a pre-declared sensitivity analysis keeps
  it in the ITT set as unresolved.
* **Primary test:** the mean difference (§7), unchanged by any diagnostic.
* **Descriptive distribution diagnostics** of Y per arm, reported and never
  tested: n, mean, SD, median, IQR (P25, P75), P90, P95, P99, max, and the
  share of tasks where the redo term is non-zero. A 99th-percentile winsorized
  mean difference is a pre-declared sensitivity analysis only.
* **Safety endpoint:** the resolution rate (official grade) among triggered
  tasks. It is monitored by §7's directional safety rules. It is not a
  hypothesis test of benefit.
* **Derived economic reporting metric:** cost and tokens per resolved task, per
  arm (ratio of sums). It is reported, never tested, never a stopping
  criterion.
* **Mechanism / manipulation checks**, not value claims:
  * masked ⇒ recover never carried out at b\* (must hold exactly);
  * P(carried at b\* | available, W = 1);
  * next-dispatch validation pass;
  * retry behaviour change (new targets in the retry).

  These become candidate value proxies only if real traces show their effect
  moves with Y, and only in a separately pre-registered later experiment.

## 7. Analysis and sequential stopping

**Notation.** At a look, `n_a`, `n_m` are the analysis-set tasks (§6) in the
available and masked arms whose outcome is final: graded, or ungraded after
the §6 re-grade rule. `Ȳ_a`, `Ȳ_m` and `s_a²`, `s_m²` are their sample means
and variances. Whether an outcome is final yet depends on calendar time
(grading lag), not on Z.

**Test statistic** (primary, at look k):

```
Z_k = (Ȳ_a − Ȳ_m) / sqrt(s_a² / n_a + s_m² / n_m)       (Welch z)
```

A negative Z_k means recover availability at b\* lowers cost-to-go.

**Information fraction:**

```
t = min(n_a, n_m) / N_max
```

This is a fixed-sample information clock. Looks happen at the first moment
`min(n_a, n_m)` reaches 759, 1,518, 2,277 and 3,035, so the planned looks have
t = 0.25, 0.50, 0.75, 1.00 exactly. The minimum before any look is
`min(n_a, n_m) = 759`. There are no other interim analyses.

**Maximum information** (planning only, see §0). With d = 0.073, two-sided
α = 0.05 and power 0.80, the fixed-sample n is
`2 · (1.95996 + 0.84162)² / 0.073² = 2,946` per arm. The group-sequential
inflation is 1.03, verified at 80.3 % power by simulating 2·10⁶ paths
(`boundaries.mjs`). So **N_max = 3,035**, the maximum information count per
arm.

**Enrollment.** Triggered main-phase tasks are enrolled (assigned) until
`min(n_a, n_m)` of *enrolled* tasks reaches N_max, unless an operational,
safety or futility stop comes first. Because assignment is a fair coin, the
larger arm ends above N_max by the random imbalance. The final look is taken
once every enrolled task's outcome is final, at which point
`min(n_a, n_m) ≥ N_max` and t = 1. N_max defines information, not the total
number of tasks.

**Masked-task budget guard, C_mask = 3,400.** This is an operational ceiling
on masked main-phase tasks, not the definition of enrollment. It sits above
N_max so that randomization alone almost never reaches it before the final
look. In the null simulation (§13, 5 scenarios × 40,000 trials), the masked
count when `min(n_a, n_m)` first reaches 3,035 was:
* median 3,035, 99.9th percentile 3,277–3,284, maximum 3,410;
* above 3,400 in 2 of 200,000 trials;
* above 3,035 in 49–50 % of trials.

A cap of 3,035 would therefore have stopped masking before the final look in
about half of all runs. If C_mask is reached, assignment stops as an
unscheduled operational stop (below), never by masking less.

**Primary efficacy boundary** — two-sided, Lan–DeMets O'Brien–Fleming-type
spending `α(t) = 2 − 2Φ(1.95996 / √t)`, total α = 0.05:

| Look k | t | Stop and reject E1 = 0 if \|Z_k\| ≥ | Cumulative α |
|---|---|---|---|
| 1 | 0.25 | 4.046 | 0.0001 |
| 2 | 0.50 | 2.861 | 0.0042 |
| 3 | 0.75 | 2.336 | 0.0208 |
| 4 | 1.00 | 2.023 | 0.0500 |

The sign of Z_k at the crossing states the conclusion. **Formal E1 efficacy
testing happens only at these four scheduled looks.** No other moment, and no
other boundary, can produce an efficacy conclusion.

**Futility** — non-binding, at looks 2 and 3. With B-value
`B_k = Z_k · √t` and design drift `θ = (1.95996 + 0.84162) · √1.03 = 2.843`:

```
CP_k = 1 − Φ( (2.023 − |B_k| − θ · (1 − t)) / √(1 − t) )
```

Stop for futility if `CP_k < 0.10`. The rule is non-binding, so it does not
change α. Ignoring it never inflates the type-I error.

**Safety rules** on the resolution endpoint, evaluated at the same four
scheduled looks. With `r_a`, `r_m` the arms' resolution rates,
`Δ = r_a − r_m`, `SE(Δ) = sqrt(r_a(1 − r_a)/n_a + r_m(1 − r_m)/n_m)` and
`Z^r_k = Δ / SE(Δ)`. Each rule is one-sided, with Pocock-type constant
**2.363** (one-sided α = 0.025 over 4 looks, simulated). Each spends its own α,
separate from the primary test.

| Rule | Stop if | Meaning |
|---|---|---|
| **Harm stop** | `Z^r_k ≤ −2.363` **and** `Δ ≤ −0.02` | recover *availability* materially worsens resolution |
| **Benefit-for-withholding stop** | `Z^r_k ≥ +2.363` **and** `Δ ≥ +0.02` | recover *masking* materially worsens resolution |

Both are **safety stops, not efficacy claims**. Either one ends assignment.
Because they are evaluated only at scheduled looks, the look at which one
fires is also a scheduled efficacy look: the E1 boundary for that look is
applied as usual. A safety stop on resolution never by itself establishes,
or rules out, an effect on Y.

**Unscheduled operational stops** — the kill switch, the USD ceiling (the
approved budget B, §8), the masked-task budget guard C_mask, an assignment
integrity error (§4), or any other operational halt — may end further
assignment at any time. They **never** produce an efficacy conclusion.

* Tasks already assigned are followed to their graded outcome.
* If those outcomes bring `min(n_a, n_m)` to the next scheduled threshold,
  that scheduled look is conducted normally, with its boundary unchanged.
* Otherwise E1 and E1′ are reported **descriptively only**: the point
  estimate, a nominal 95 % Welch interval labelled "descriptive, not a test",
  n per arm, and t. No boundary is recomputed for the unscheduled time, and no
  efficacy claim is made.

**Reported at the final analysis** — at the scheduled look that stopped the
experiment or completed it; under the descriptive rule above after an
unscheduled stop:
1. the ITT eligibility effect E1 on Y. At a scheduled look this comes with the
   repeated-confidence interval `(Ȳ_a − Ȳ_m) ± c_k · SE` (c_k is that look's
   efficacy boundary) and, as a sensitivity, a task-level bootstrap CI (2,000
   resamples, seed in config);
2. the would-select subgroup effect E1′, with the same interval construction,
   n per arm, and the share of triggered tasks with W = 1;
3. the substitution effect: Z's effect on P(M\* = a substitute) and on
   interventions per task;
4. the carry-out rate P(carried at b\* | Z = available), overall and for W = 1,
   as a descriptive rate, never a divisor; plus the later-recover rate per
   arm;
5. the safety outcome: r_a, r_m, Δ, and Z^r (at a scheduled look; descriptive
   after an unscheduled stop);
6. the whole-task cost outcome: mean Y per arm, the §6 distribution
   diagnostics, and the derived cost and tokens per resolved task.

E1 and E1′ are always described as effects of *recover availability at
b\**. Never as effects of executing recover.

## 8. Pilot — feasibility and sample size only

**Setup:** 40 SWE-bench Verified instances × 1 run, Haiku 4.5 for every role,
one build (the `h26-prereg` commit), D1 and D2 in place, the §4 assignment with
ε = 0.5, run through the Arm B harness (`bench/governor/real/`) under
`h26/config.json`.

**Measured** — each as a count, a rate over all tasks, and a rate over the
previous step:

```
all tasks
 → governable-boundary rate   (≥ 1 interventionEligible boundary)
 → recover-candidate rate     (≥ 1 justified recover candidate)
 → triggered rate             (reaches b*: every §5 rule holds)
 → would-select recover rate  (W = 1 at b*)
 → recover carry-out rate     (carried at b* | Z = available, W = 1)
 → substitution rate          (M* = substitute | Z = masked, W = 1)
 → outcome variance           (SD and the §6 diagnostics of Y, triggered tasks)
```

plus:
* **Assignment balance:** n_available, n_masked and the observed ratio
  n_available / n_masked among triggered tasks, alongside integration
  criterion 3's binomial check.
* **Cost per task** in USD.
* **D2 diagnostics:**
  * first-dispatch turn-cap hit (yes/no, and turns used of T − R);
  * first-dispatch termination reason (completed, `error_max_turns`, budget
    stop, error, timeout);
  * dispatch count to b\* (for triggered tasks).

  These detect whether the retry reservation materially changes
  first-dispatch completion behaviour, for example a rise in first dispatches
  ending on `error_max_turns` at T − R turns. **D2 itself (T, R) cannot be
  tuned from pilot outcomes.** A material change is reported as a finding
  about the benchmark generation. Changing T or R would be a new
  pre-registration.

**What the pilot cannot do:** it estimates feasibility and sample size only.
It cannot tune the assignment (ε, the key, the unit, the HMAC message), the
estimands, the eligibility rules, the outcomes, the boundaries, N_max, the
design alternative, the turn budgeting (T, R) or the gate. Pilot tasks are
not in the main analysis, and no effect is estimated from them.

**Integration pass criteria** (all required):
1. 100 % of recover-eligible and excluded boundaries are logged with every §9
   field;
2. masked ⇒ recover never carried out at b\*, with zero exceptions;
3. the number masked is inside the two-sided 95 % Clopper–Pearson interval for
   Binomial(n_triggered, 0.5);
4. no safety-rule violation;
5. the kill switch, exercised once, prevents assignment for every
   subsequently started task (logged `refused:kill_switch`);
6. each of the six tagged-build checks (§4) is shown, once each, to refuse
   assignment when violated;
7. zero `experiment.write_failure` events, and every `experiment.assignment`
   record is complete and was never updated.

**Feasibility gate** (go / no-go for the main run). B is the approved budget
in USD, frozen in `h26/config.json` before the tag.

Let x be the triggered count among the n = 40 pilot tasks. Let c₁…c₄₀ be the
per-task costs.

* **Triggered rate, conservative lower bound:**
  `p_L = BetaInv(0.05; x, n − x + 1)`. This is the one-sided 95 %
  Clopper–Pearson exact lower bound, with `p_L = 0` when x = 0.
* **Cost per task, conservative upper bound:**
  `c_U = max( c̄ + t_{0.95, 39} · s_c / √40 ,  q_{0.95} )`.
  `t_{0.95,39} = 1.685`. `q_{0.95}` is the 95th percentile of 10,000
  percentile-bootstrap resample means of c, seed from config. Taking the max
  of the two guards against the bootstrap's undercoverage at n = 40 with heavy
  tails.
* **Projected tasks:** `N_tasks_U = ⌈2 · N_max / p_L⌉` (∞ when p_L = 0).
* **Projected cost:** `Cost_U = N_tasks_U · c_U`.
* **GO** iff `x ≥ 1`, `Cost_U ≤ B`, and every integration criterion passed.
  **NO-GO** otherwise. Then the experiment is not run, and recover stays priced
  by the market as in H2.5.

A worked illustration with *hypothetical* numbers, not a prediction: if
x = 6, then p_L = 0.0674 and N_tasks_U = ⌈6,070 / 0.0674⌉ = 90,060. At
c_U = $0.40 that is Cost_U = $36,024.

## 9. Logging

`experiment.assignment` is one immutable, complete record per triggered
task, written atomically at §4 step 5. `experiment.boundary` is written at
every later recover candidate and at every excluded boundary.
`experiment.write_failure` records a failed assignment write (§4).

| Field | Source |
|---|---|
| experimentId, pre-registration tag, build commit, `configSha256`, `lockfileSha256`, `installedTreeSha256`, `buildFingerprint` | config / build (§4) |
| phase (`pilot` / `main`) — pilot rows are excluded from every main analysis and from the C_mask guard | config |
| rootTaskId, nodeId, stateVersion | boundary (the record) |
| decisionId, chosen action, whether it carries recover, experiment-path latency | the `bstar_decision` event; `bstar_final_decision` when System-1 changed the choice |
| Z, ε, HMAC message, u(τ) | §4 step 4, in the same record as W |
| candidate capability, fingerprint, kind | candidate |
| state signature (`statePattern`), task regime (failing, validation status), phase | state |
| `snapshotDigest`, unmasked candidate rank among feasible, market margin (USD and share of budget), W | the unmasked pricing (§4 steps 2–3) |
| market choice M\*, and a substitute flag | the decision |
| carried out at b\* (`governor.intervention_carried`, carry-out tokens) | lifecycle |
| later recover candidates and carry-outs | `experiment.boundary` |
| exclusion rule, if excluded | §5 |
| D2 diagnostics: first-dispatch turns, cap hit, termination reason; dispatch count to b\* | lifecycle |
| downstream: cost, tokens, turns and dispatches from b\* to the end; validation results after b\* | events |
| task: final state, validated, total cost and tokens, **official grade (joined offline)** | run + grader |

## 10. Invariants

* **Runtime learning OFF.** Experiment rows live in the experiment ledger
  (§4) and in `experiment.*` events. No governor, market or estimator path
  reads them; the only reader is the assignment path itself. Learned capability value, replay, discovery, the adaptive horizon and
  runtime calibration stay off. H2.5 production policy is unchanged.
* No shadow execution: the unmasked pricing at b\* is arithmetic over one
  candidate set, not a second run.
* No second planner. No oracle at runtime: the grade is joined offline.
* No per-tool-call interception: boundaries remain dispatch boundaries.
* The frontier agent stays autonomous, and the Economic Action Market stays
  the sole chooser.

## 11. Integration requirements (to implement after approval)

1. **D1:** the `observable` / `interventionEligible` / `recoverEligible`
   predicates, with `ineligible:no_telemetry` recorded once per boundary.
2. **D2:** T / R turn budgeting, identical across arms, the spend guard
   evaluated against T, and the §9 D2 diagnostics.
3. **Masking hook:** at b\* only, the order of operations in §4: unmasked
   pricing and its snapshot digest, then W, rank and margin, then u and Z,
   then the single atomic record write, then the infeasible mark.
4. **Assignment:** the HMAC function, the six tagged-build checks, the kill
   switch and the C_mask guard.
5. **Logging:** the §9 events (one atomic, insert-only, immutable assignment
   record in the experiment ledger).
6. **Offline scripts:** the §7 monitor, the §8 gate and the final analysis.
7. **Tests for every rule above,** then code review, then the configuration,
   then the tag (§12).

## 12. What `h26-prereg` freezes

A git tag freezes the whole tree at its commit. The tag is created only after
every file below exists and is committed, the unit suite passes, and the code
review is done. These are the files that define the experiment — anything
else changing would be a new experiment:

**Design and configuration**
* `bench/governor/h26/DESIGN.md` — this document.
* `bench/governor/h26/config.json` — experimentId, ε, the HMAC message prefix,
  keyCommitment, N_max, C_mask, the look schedule, the boundaries (4.046,
  2.861, 2.336, 2.023; futility θ, CP threshold; safety constant 2.363,
  margin 0.02), T and R, the price snapshot, the budget B, the bootstrap
  seeds, the phase (`pilot` / `main`), the pilot instance list, the model pin,
  and the per-task cap.

**Offline scripts**
* `bench/governor/h26/monitor.mjs` — the §7 look computation.
* `bench/governor/h26/gate.mjs` — the §8 go/no-go.
* `bench/governor/h26/analysis.mjs` — the §7 report.
* `bench/governor/h26/boundaries.mjs` and its output `boundaries-result.json`
  — the simulation that re-derives every constant and validates the full
  procedure's type-I error under the null (§13).
* `bench/governor/h26/survey-real.cjs` — the funnel survey.

**Real-run harness**
* `bench/governor/real/run-real.mjs`, `schedule-real.mjs`, `collect-real.mjs`,
  `grade-real.sh`, extended for the experiment config.

**Runtime (planned locations)**
* D1: `src/decision/fallback.ts`, `src/lifecycle/economic-runtime.ts`.
* D2: `src/efficiency/policy.ts` (`effectiveTurnCap`),
  `src/lifecycle/node-actor-manager.ts` (`evaluateTaskSpend`, the dispatch
  caps).
* Masking and assignment: a new `src/experiment/recover-eligibility.ts`, wired
  into the market input in `src/lifecycle/economic-runtime.ts`;
  `src/decision/engine.ts` only if the existing `executable` path is
  insufficient.
* Feasibility filter (unchanged): `src/lifecycle/executable.ts`.
* Their tests: `src/experiment/recover-eligibility.test.ts`, D1/D2 tests
  beside their modules, and the harness self-checks.
* `package-lock.json` — dependency versions.

**In the annotated tag's message** (not the tree): `configSha256`,
`lockfileSha256`, `installedTreeSha256`, `buildFingerprint`, `keyCommitment`
(§4).

**Outside the tag:** the key itself (only its commitment is inside). It is
revealed after the final analysis.

No assignment is drawn before the tag exists. After the tag, any change to a
file above creates a new experiment id and a new tag.

## 13. Null validation of the full procedure

`boundaries.mjs` (seed 20261002) re-derives the constants and runs the
**actual** analysis procedure under the null:
* fair-coin assignment;
* Y built as in §6 (`f · C(task) + 1[unresolved] · C(task)`, f ~ U(0.3, 0.9));
* equal E[Y] and equal resolution rate in the two arms, with unequal spread;
* the Welch statistic at the four scheduled looks, with the O'Brien–Fleming
  boundaries, the non-binding futility rule (enforced) and both safety stops.

It ran 40,000 trials per scenario (Monte Carlo SE ≈ 0.0011 at 0.05).
**Validation only: no constant was changed from it.** The result file is
`boundaries-result.json`.

Boundary constants (2·10⁶ Brownian paths):
* two-sided efficacy α = 0.0502;
* cumulative α by look 0.00005 / 0.0042 / 0.0210 / 0.0502;
* one-sided safety α = 0.0248;
* power at the design drift = 0.803.

| Null scenario | Type-I, efficacy boundaries only | Type-I, full procedure | False harm stop | False benefit-for-withholding stop | Futility stop |
|---|---|---|---|---|---|
| normal, equal variance (sanity) | 0.0500 | 0.0481 | 0.0215 | 0.0237 | 0.542 |
| lognormal σ 0.8 (available) vs 1.3 (masked) | 0.0571 | 0.0539 | 0.0223 | 0.0230 | 0.533 |
| lognormal σ 1.3 vs 0.8 | 0.0587 | 0.0557 | 0.0226 | 0.0218 | 0.532 |
| Pareto α = 3 vs lognormal σ 0.8 | 0.0490 | 0.0443 | 0.0209 | 0.0224 | 0.544 |
| Arm B-fitted lognormal (μ, σ from the 20 Arm B runs; masked spread ×1.5; r = 0.3) | 0.0609 | 0.0580 | 0.0214 | 0.0225 | 0.525 |

Findings, recorded as they are:
* The boundaries spend α as declared. With well-behaved outcomes (normal,
  and Pareto α = 3 against lognormal) the full procedure's type-I error is at
  or below 0.05.
* With strongly right-skewed outcomes whose skewness differs between arms, the
  Welch statistic is **anti-conservative**. The type-I error of the efficacy
  boundaries alone reached 0.057–0.061, about 6–9 Monte Carlo SE above 0.05.
  The full procedure (futility and safety stops end some trials early) reached
  0.054–0.058. The worst case is the scenario fitted to the Arm B costs. This
  is a known property of mean-difference tests under unequal skewness at these
  sample sizes, not a defect of the boundaries.
* Both safety stops stay at or below their one-sided 0.025.
* The masked count at the final look motivates C_mask = 3,400 (§7).

The pre-registered boundaries and test statistic are unchanged. The
**declared** level is α = 0.05. Under heavy, arm-asymmetric skew the
**realized** level may be up to about 0.06, and the final report states this
alongside every efficacy result. Any change to the statistic or boundaries
would be a new pre-registration, decided before the tag.
