# Public benchmark v2 — CherryOnTop vs. direct Claude Sonnet 5

> Hand this entire file to a fresh agent session with the repository checked out
> clean. It produces a **publishable** report comparing CherryOnTop's
> orchestration layer against a direct Claude Sonnet 5 agent on six tasks drawn
> from two established benchmarks.
>
> It supersedes `PUBLIC-BENCHMARK-PROMPT.md` (n=20, SWE-bench only). Everything
> that document got right is carried forward. What changed is driven by measured
> evidence from the 2026-09-21 run, and §0.4 explains each change and why.
>
> **Do not deviate from §1 (pre-registration) once data collection starts.**

---

## 0. Read this before running anything

### 0.1 What is actually being compared

CherryOnTop **dispatches Claude Code**. `src/adapters/claude-code.ts` shells out
to `claude --print --output-format stream-json …`. The model is held constant on
both sides.

> **The claim under test:** holding the model, the task, the repository, the
> tool permissions, the reasoning effort and the dollar ceiling constant, does
> CherryOnTop's orchestration layer — one control snapshot, a staged strategy
> gate, progressive context, progressive validation, delegation, recovery —
> change the **probability of solving a task** and the **cost of solving it**,
> relative to a direct Claude Sonnet 5 agent?

This is a **harness / scaffold comparison**. That is a legitimate and
publishable category — the same one SWE-agent, OpenHands, Agentless, Moatless
and DeepSWE's own harness compete in.

**Write the arms as:**

| Arm | Meaning |
|---|---|
| `direct-sonnet5` | The benchmark platform's own reference Claude Sonnet 5 agent configuration, run by us |
| `cherryontop` | The same Claude Sonnet 5, orchestrated by CherryOnTop |

**Presenting this as "CherryOnTop beats Claude Sonnet 5" would be false** and is
the fastest way to lose the report's credibility. The model is the constant.

### 0.2 The direct arm is run by us, not cited

A published leaderboard figure is **not** the direct arm. Harness differences
dominate leaderboard deltas, and a published aggregate cannot be paired
instance-by-instance with our runs, which is what every statistic in §8 needs.

So: **run the direct arm yourself**, using the benchmark platform's own
published reference configuration for Claude Sonnet 5 — its scaffold, its tool
surface, its prompt template — so that our direct arm is as close as possible to
the configuration behind the published number.

The published figure then serves exactly one purpose: **a calibration check**.
If our direct arm scores far below the published Sonnet 5 figure on the same
benchmark, our direct arm is misconfigured and the whole comparison is invalid
until that is fixed. Report the check in §Report/2 and state the gap.

### 0.3 Sample size, stated honestly up front

Six tasks, one repetition per cell. This is a **small, directional study**, and
the report must say so in its first paragraph. Concretely:

- Resolve rate at n=6 has a 95% Wilson interval of roughly **±35 percentage
  points**. A 5/6 vs 4/6 difference is indistinguishable from noise.
- Paired Wilcoxon at n=6 can reach p = 0.031 only if **all six** differences
  share a sign. Anything less is not significant, and saying so is mandatory.
- One repetition provides **no within-cell variance estimate of its own.**

The verdict ceiling for this design is therefore **DIRECTIONAL**, never **WIN**.
See §9 for the verdict table. A report that claims a win from this design will
not survive contact with a competent reader.

### 0.4 What changed from v1, and the evidence for each change

| Change | Evidence |
|---|---|
| **Primary endpoint moved from cost to resolve rate** | The 2026-09-21 variance probe found **zero resolution flips across 18 graded cells** (3 instances × 2 arms × 3 reps) — resolution is stable. Cost is not: within-cell SD reached **$1.78** on one direct-arm cell, against a whole-dataset mean paired cost difference of **$0.22**. At one repetition, a cost-primary design is pre-registered to be inconclusive before any data is collected. |
| **Cost demoted to secondary, with a measured noise floor overlaid** | Same probe. The prior SDs are a legitimate external prior and are cheaper than re-measuring. |
| **Conditional variance top-up (§7.3)** | Adds repetitions *only* if the observed cost delta lands inside the known noise floor. Pre-registered, so it is not p-hacking; costs nothing when the data is clear. |
| **Two task tiers (§2)** | On SWE-bench Verified the previous run created **zero child nodes across all 14 CherryOnTop dispatches** while the market authorized `DELEGATE` 10 times. Delegation cannot be observed on that distribution. Tier B exists to give it a chance to fire. |
| **Reasoning effort pinned explicitly (§4)** | Sonnet 5 exposes `effort` (`low`…`max`, default `high`; Claude Code defaults to `xhigh`). Two arms at different effort levels is a confounded comparison, and nothing in v1 pinned it. |
| **Exact model id, never an alias** | `bench/swebench/run_instance.mjs` currently pins `PINNED_MODEL = 'sonnet'`. An alias can resolve differently between arms or sessions. Must become `claude-sonnet-5`. |
| **Pricing corrected** | Sonnet 5 introductory pricing ($2/$10 per MTok) **expired 2026-08-31**. Standard rates are **$3.00 input / $15.00 output per MTok**, cache write 1.25× input, cache read 0.1× input. |

---

## 1. Pre-registration — commit this before collecting data

Commit this section, unmodified, **before the first paid run**, and link the
commit hash in the report. If you later change an endpoint, say so explicitly
and label the new one exploratory.

| | Endpoint | Test | Decision rule |
|---|---|---|---|
| **Primary** | Resolve rate, paired per task | McNemar exact on discordant pairs; Wilson 95% CI per arm | **Non-inferiority gate**: CherryOnTop must not be meaningfully worse. Report discordant pairs individually — at n=6 they *are* the result |
| **Secondary A** | Cost (USD) per task, paired | Wilcoxon signed-rank + bootstrap CI on the paired median difference | Compared against the prior noise floor (§7.3) before any claim |
| **Secondary B** | Cost per *resolved* task | Descriptive + bootstrap CI | Descriptive only at this n |
| **Secondary C** | Wall-clock, turns, dispatches, all four token classes | Paired, descriptive | |
| **Mechanism** | Which CherryOnTop mechanisms fired, and how often | Counts | Explanatory only. **Never** used to support the primary claim |
| **Exploratory** | Failure taxonomy; Tier A vs Tier B contrast | Descriptive | Tiers are **never pooled** into one headline number |

**Hard gates, decided now:**

1. **Cheaper-and-worse is a loss.** A cost reduction accompanied by a resolve-rate
   drop is reported as a loss, whatever the p-value.
2. **A mechanism that did not fire earns no credit** and must be listed as
   not-fired.
3. **Tier A and Tier B are reported separately.** Six tasks from two different
   benchmarks do not average into one number.

---

## 2. Task selection — six tasks, two tiers

Select and freeze the task list **before any run**. Publish it verbatim.
Cherry-picking is the most common way these reports are quietly rigged, and the
only defence is showing the list, the seed, and the selection rule.

### 2.1 Tier A — 4 × SWE-bench Verified

Source: `princeton-nlp/SWE-bench_Verified`. Draw with a **fixed seed**, one
instance per distinct repository, stratified by the dataset's own `difficulty`
field:

| Slot | Difficulty stratum | Purpose |
|---|---|---|
| A1 | `<15 min fix` | Simple. The orchestration-tax case |
| A2 | `<15 min fix` | Simple, different repository |
| A3 | `15 min - 1 hour` | Hard |
| A4 | `>1 hour` if the stratum is non-empty, else a second `15 min - 1 hour` | Hardest available |

Record per instance: `instance_id`, `repo`, `base_commit`, `difficulty`,
`problem_statement` character count, `FAIL_TO_PASS` count, `PASS_TO_PASS` count.
Write them to `bench/swebench/instances-v2.json` and **publish that file**.

**Do not reuse the eight instances from the 2026-09-21 run.** They have been
seen; reusing them invites the charge that the set was chosen knowing the
outcome. Use a different seed and say which.

### 2.2 Tier B — 2 × long-horizon, multi-workstream

This tier exists for one reason: **SWE-bench Verified cannot exercise
delegation.** Tier B tasks must be genuinely multi-deliverable — the shape
`assessDecomposition` is designed to split — or the tier fails its purpose.

Selection criteria, in order:

1. The task comes from an **established public benchmark with a documented
   harness** (Terminal-Bench, SWE-Lancer IC-SWE, SWE-bench Multimodal, or a
   comparable long-horizon agentic suite).
2. The benchmark has a **published Claude Sonnet 5 result you can cite** with a
   date, a harness description and a URL. **Verify this at selection time — do
   not assume it exists.** If no Sonnet 5 baseline is published for any
   candidate benchmark, fall back in this order, recording which was used and
   why: (a) nearest published Claude model on the same benchmark, clearly
   labelled as a different model; (b) no external baseline at all, with Tier B
   reported as self-run-only. **Never invent or approximate a published number.**
3. The task statement names **two or more independent deliverables** — the
   property that makes delegation possible at all.
4. Its reference solution touches **more than one module**.

Record the same per-task fields as Tier A, plus the benchmark name, its harness
version, the grading command, and the published-baseline citation.

### 2.3 If Tier B tasks still do not trigger delegation

**Report it as the finding.** Do not add tasks, do not force a fan-out by
configuration, and do not tune the decomposition thresholds to make it happen —
rule 13 forbids tuning mid-study, and a delegation produced by moving a
threshold until it fires is evidence about the threshold, not the architecture.

A section reading *"delegation did not fire on any of six tasks; here is the
decision trace showing why the policy declined"* is a legitimate, informative,
publishable result. It is also the outcome the prior evidence predicts.

---

## 3. The two arms, exactly

Both arms receive **identical** inputs. Per task, the runner must:

1. Materialise a fresh isolated worktree at `base_commit`
   (`bench/lib/isolation.mjs` — the 2026-09-20 run proved this load-bearing).
2. Write the task's `problem_statement` **verbatim**. No CherryOnTop-specific
   hints, no reformatting for one arm only.
3. Run one arm.
4. Capture `git diff` from the worktree as the `model_patch`.
5. Tear the worktree down.

**Arm A — `direct-sonnet5`**, the platform's reference configuration:

```
claude --print --output-format stream-json --verbose \
  --model claude-sonnet-5 \
  --max-turns <N> \
  --allowedTools <SAME_LIST> \
  --dangerously-skip-permissions \
  "<problem_statement>"
```

**Arm B — `cherryontop`:**

```
ORG_MODEL_EXECUTE=claude-sonnet-5 \
ORG_TASK_SPEND_CAP_USD=<B> \
org run "<problem_statement>" --repo <worktree> \
  --spawn --max-children 3 --budget <B>
```

### 3.1 Required code change before running

`bench/swebench/run_instance.mjs` pins `PINNED_MODEL = 'sonnet'` — an alias.
Change it to the exact id and record the resolved model per run:

```js
const PINNED_MODEL = 'claude-sonnet-5';
```

Also confirm the live budget monitor's rate table matches current standard
pricing (introductory pricing expired 2026-08-31):

```js
const RATE = { input: 3e-6, output: 15e-6, cacheWrite: 3.75e-6, cacheRead: 0.3e-6 };
```

That table is used **only** for the budget kill-switch. The reported cost is
always the CLI's own `total_cost_usd`, or the last-seen running estimate clearly
flagged as estimated for a budget-aborted run.

---

## 4. Parity — what must be equal, what cannot be

| Must be **identical** | Why |
|---|---|
| Task set and `base_commit` | Pairing |
| Task text, verbatim | Prompt sensitivity is enormous |
| **Model id, exact, never an alias** — `claude-sonnet-5` | Otherwise it is a model comparison |
| **Reasoning effort** (`output_config.effort`) | Sonnet 5 supports `low`…`max`; default `high`, Claude Code default `xhigh`. Pin one value, state it, use it on both arms |
| **Thinking mode** — `{type: "adaptive"}` on both | Sonnet 5's only on-mode. `budget_tokens` returns 400 on this model; do not set it |
| Tool allowlist | Capability parity |
| Container image / OS / Python | Environment parity |
| Network egress policy | Some tasks are solvable by lookup |
| Dollar ceiling per task | The fair equaliser — see below |
| Grading harness and command | No self-report |

| Cannot be identical — **must be disclosed** | Note in the report |
|---|---|
| Number of model dispatches | CherryOnTop makes several; direct makes one. **This is the thing under test** |
| Per-role model tiering | CherryOnTop routes plan/synthesise roles to a cheaper tier. Report the per-role token and cost split, or a reader will credit orchestration for a saving that came from tiering |
| Turn-budget semantics | `--max-turns` per dispatch vs. CherryOnTop's adaptive cap. **Equalise on dollars, not turns** |
| Scaffolding prompt text | CherryOnTop appends a system prompt. Publish it verbatim |

**Equalise on money.** Same hard dollar ceiling `B` per task per arm; each arm
spends it however it likes. Equalising on turns is meaningless across a
one-dispatch and a many-dispatch architecture; equalising on wall-clock
penalises the arm that parallelises.

**Record the ceiling-hit count per arm.** A run cancelled at the ceiling is a
different object from one that finished, and the prior probe's single largest
noise source was exactly this: one direct-arm repetition cancelled at $5.06 with
139 turns while another repetition of the same cell finished at $1.86.

---

## 5. Metrics — capture everything, per run

### 5.1 Identity and provenance
`task_id` · `tier` (A/B) · `benchmark` · `repo` · `base_commit` · `arm` ·
`repetition` · `arm_order_position` · `started_at` · `ended_at` ·
`cherryontop_revision` · `claude_cli_version` · `resolved_model_id` ·
`effort_setting` · `harness_version` · `operator` · `hostname`

### 5.2 Outcome
`resolved` (bool, official harness only) · `runtime_state`
(`COMPLETE`/`FAILED`/`CANCELLED`/`TIMEOUT`/`UNRUNNABLE`) · `validity_class`
(`bench/lib/validity.mjs`) · `ceiling_hit` (bool) · `patch_bytes` ·
`files_touched` · `patch_empty` (bool)

> `runtime_state` and `resolved` are **different facts** and must never be
> collapsed. The prior run recorded an instance the runtime judged `FAILED`
> that the official grader marked resolved.

### 5.3 Cost and tokens — all four classes, always
`cost_usd` · `cost_estimated` (bool) · `input_tokens` · `output_tokens` ·
`cache_read_tokens` · `cache_creation_tokens` · `total_tokens`

> `cache_read_tokens` is usually the real bill: a measured dispatch showed 22–46
> input tokens against 1.77M cache-read. A comparison on `input_tokens` alone
> compares two rounding errors. **Report all four, and report the cost split by
> class** using $3.00 / $15.00 / 1.25× / 0.1× per MTok.

### 5.4 Work shape
`turns` · `dispatches` · `wall_seconds` · `queued_seconds` ·
`per_role_breakdown` (role → model, turns, tokens, cost)

### 5.5 CherryOnTop mechanism counters (arm B only, explanatory)
`strategy` (`MANAGED`/`SERIAL_DELEGATED`/`PARALLEL_DELEGATED`) ·
`strategy_deterministic` (did the classifier get bought?) · `children_created` ·
`delegation_plan_valid` + rejection reasons · `delegation_topology` ·
`delegation_scheduled_events` · `market_authorized` / `market_vetoed` ·
`execution_gate` reasons · `validation_level_reached` · `validation_passed` ·
`validation_reason_codes` · `minimum_level_required` · `recovery_count` ·
`strategy_retry_refused` · `spend_guard_fired` · `context_tokens_selected` /
`context_ceiling` · `full_artifact_requests` · `plan_cache_hits` /
`result_cache_hits` · `counterfactual_prediction_error`

Extract with `org tokens <id> --json --economic`, `org decision <id>`, and the
`memory` rows `strategy_decision`, `delegation_plan_validation`,
`strategy_counterfactual`, plus `validation.result` events.

### 5.6 Derived, per arm
Resolve rate + Wilson 95% CI · mean/median cost · cost per resolved task · total
spend · mean wall-clock · token totals by class · valid-row count · ceiling-hit
count

### 5.7 Derived, paired per task
Δcost · Δtokens (per class) · Δturns · Δdispatches · Δwall · resolution
agreement (both / A-only / B-only / neither — the McNemar 2×2)

---

## 6. Preflight

```bash
node --version && git rev-parse HEAD && git status --porcelain
npm test && npm run typecheck && npm run build
docker --version && kubectl get nodes && claude --version && python3 --version
node bench/capability-regimes.mjs && node bench/strategy-regimes.mjs
```

**Gate — stop if any fails:** Node ≥ 22 · working tree **clean** · all tests
pass · Docker running · `kind` cluster up · `claude` authenticated · all
capability regimes reachable.

Record the exact `claude` CLI version and the resolved model id. Both go in the
report.

---

## 7. Run protocol

### 7.1 Smoke — 2 tasks × 2 arms = 4 runs

Run one Tier A and one Tier B task through both arms end to end, including
grading.

**Gate — stop if any is false:**
- both arms produce a non-empty `model_patch`
- the official harness grades both without erroring
- per-run cost is recorded and non-zero for both
- arm B records decisions (`org decision <nodeId>`) and a `validation.result`
- both worktrees were freshly isolated
- the resolved model id is `claude-sonnet-5` on **both** arms

### 7.2 Main run — 6 tasks × 2 arms × 1 repetition = 12 runs

**Randomise arm order per task and record it** before running. Never always run
A then B: provider-side load and rate-limit state drift across a session and
would otherwise be confounded with the arm. Run sequentially — the cluster and
local Docker are shared resources.

### 7.3 Conditional variance top-up — pre-registered, may cost nothing

The 2026-09-21 probe measured within-cell cost SD up to **$1.78** (direct arm)
and **$0.24** (CherryOnTop arm), against a whole-dataset mean paired cost
difference of **$0.22**.

**Rule, fixed now:** after the main run, compute the paired median Δcost. Then:

- **If |median Δcost| ≥ $1.78** — the delta exceeds the measured noise floor.
  Report the cost result with the prior SD overlaid as context. No extra runs.
- **If |median Δcost| < $1.78** — the delta is inside the known noise floor.
  Either (a) run **2 extra repetitions on the 2 tasks with the largest |Δcost|**
  (4 extra runs) and report cost with the freshly measured within-cell SD, or
  (b) publish cost as **INCONCLUSIVE** and say plainly that the observed
  difference is smaller than previously measured run-to-run noise.

Choose (a) or (b) on budget, not on which gives a nicer answer, and **state
which you chose and why** in the report.

The primary endpoint (resolve rate) is unaffected either way: resolution showed
zero flips across 18 cells and does not need this treatment.

### 7.4 Grading — official harness only

Never grade by self-report and never by asking a model.

Tier A:

```bash
python -m swebench.harness.run_evaluation \
  --dataset_name SWE-bench/SWE-bench_Verified \
  --predictions_path <arm>.jsonl \
  --run_id <arm>-v2-<date> \
  --max_workers 4
```

A Tier A task is **resolved** iff all `FAIL_TO_PASS` and all `PASS_TO_PASS`
tests pass, per the harness. That is the only definition permitted.

Tier B: use that benchmark's own official grading command, recorded verbatim.

---

## 8. Analysis

Run the §1 tests and nothing else. Reuse `bench/compare.mjs` (`pairRuns`,
`pairedDifference`, `signTestP` — an exact two-sided binomial on discordant
pairs, which **is** McNemar's exact test) and
`bench/lib/validity.mjs` (`partitionByValidity`).

**Only `VALID` rows enter statistics.** Infrastructure, environment, telemetry
and snapshot failures and aborts are counted, named and excluded. **If valid
< 80% of attempted runs, the result is INCONCLUSIVE** — say so and stop.

Report Tier A and Tier B separately throughout. Give the pooled six-task number
only if you also give both tier numbers beside it and state that the tiers come
from different benchmarks with different graders.

---

## 9. Verdict table

| Verdict | Conditions |
|---|---|
| **DIRECTIONAL — favourable** | Resolve rate non-inferior (no significant McNemar against CherryOnTop, discordant pairs listed individually) **and** paired cost lower with the delta exceeding the §7.3 noise floor |
| **DIRECTIONAL — neutral** | Resolve rate non-inferior, cost indistinguishable from the noise floor. Report which mechanisms fired anyway |
| **LOSS** | Resolve rate meaningfully down, **or** cost up beyond the noise floor |
| **INCONCLUSIVE** | Valid < 80%, or the cost delta sits inside the noise floor and no top-up was run, or a grading harness failed |

**There is no WIN row.** Six tasks at one repetition cannot support one. The
most likely honest outcomes are DIRECTIONAL — neutral and INCONCLUSIVE;
publishing either is far better for credibility than a win nobody can reproduce.

---

## 10. Hard rules

1. **Never present this as a model comparison.** The model is constant; the
   harness is the variable.
2. **No head-to-head claim against any agent you did not run.** External numbers
   appear only in a labelled context table, with citations, dates and harness
   descriptions, and an explicit "not run by us, not comparable as a
   head-to-head" note.
3. **Pre-register §1 before looking at data. Commit it. Link the commit.**
4. **Publish the task list and the seed.** Non-negotiable.
5. **Grade only with the official harness.** No self-report, no LLM judge.
6. **Randomise arm order per task; record it.**
7. **Only `VALID` rows enter statistics.** Below 80% valid → INCONCLUSIVE.
8. **Report every CI even when it is embarrassing.** At n=6 the resolve-rate CI
   is roughly ±35pp. State it; do not round it away.
9. **Cheaper-and-worse is a loss.**
10. **Disclose contamination.** SWE-bench Verified is public and almost
    certainly in training data. That does not invalidate a *paired harness*
    comparison — both arms have the same advantage — but it must be stated, and
    it bars any claim about absolute capability.
11. **Disclose the conflict of interest above the fold.** You built CherryOnTop.
12. **Publish the raw artifacts**: every patch, every log, every cost row, the
    grading output, the scaffolding prompts, the exact commands, the arm order.
13. **No tuning between arms and no tuning mid-study.** If you find a bug, stop,
    fix it, and restart the affected runs from scratch on the new revision,
    documenting it — as the 2026-09-20 report did.
14. **State total spend.**
15. **Never retry a product failure.** Retry infrastructure failures at most
    twice; a retried real failure becomes a flake.
16. **Never report a mechanism as working because it was authorized.** The prior
    run authorized `DELEGATE` ten times and created zero children. Authorization
    is not execution.

---

## 11. Report structure

```
# CherryOnTop vs. direct Claude Sonnet 5 — a six-task directional study

**TL;DR** — one paragraph: arms, n, primary endpoint, result with CI, verdict,
and the words "directional" and "six tasks" in the first two sentences.

**Conflict of interest** — the author builds CherryOnTop. Above the fold.

**What this is not** — not a model comparison; not a head-to-head with any agent
we did not run; not a full benchmark run; not powered to detect small effects.

## 1. Setup
Arms, exact model id, effort setting, CLI version, revision, dates, hardware,
container image, tool allowlist, dollar ceiling, scaffolding prompts (verbatim),
seed, task list (link the frozen file).

## 2. Calibration of the direct arm
Our direct arm's score vs. the published Sonnet 5 figure on the same benchmark,
with citation and date. State the gap and what it implies.

## 3. Method
Pairing, randomised arm order, worktree isolation, budget equalisation, official
grading, pre-registration commit hash.

## 4. Validity
Attempted vs valid runs, excluded by class with reasons, ceiling-hit counts.

## 5. Primary result — resolve rate
McNemar 2×2, per-arm rates with Wilson CIs, every discordant pair named
individually. Tier A and Tier B separately.

## 6. Secondary — cost
Paired table, median Δ, bootstrap CI, Wilcoxon p, and the §7.3 noise floor
drawn on the same axis. State which §7.3 branch you took.

## 7. Secondary — work shape
Tokens by all four classes, cost split by class, turns, dispatches, wall-clock,
per-role breakdown.

## 8. Mechanism attribution
Which CherryOnTop mechanisms fired, how often, at what cost — and an explicit
list of those that did NOT fire. Delegation gets its own subsection either way.

## 9. Failure taxonomy
Categorised failures per arm with example task ids and patch excerpts.

## 10. External context (NOT head-to-head)
Published figures for other agents on these benchmarks, cited, dated, with
harness descriptions and an explicit non-comparability note.

## 11. Threats to validity
Sample size and the ±35pp CI. One repetition. Contamination. Provider drift.
Model tiering confound. Effort-setting sensitivity. Single operator. Two
benchmarks with different graders. Task selection.

## 12. What this does and does not establish
Two short lists. Be strict. The "does not" list should be longer.

## 13. Reproduction
Exact commands, revision, seed, artifact links, raw JSONL.
```

---

## 12. Cost and scope

- Smoke 4 runs · main 12 runs · optional top-up 4 runs = **16–20 agent runs**.
- Tier A budget **$2–4 per run**; Tier B long-horizon tasks may need **$5–8**.
- Expect **$60–140** total, plus a top-up contingency of ~$30.
- Set a hard ceiling before starting and abort against it.
- Grading is free but CPU- and disk-heavy: allow **~40 GB** for Docker images.
- **If the budget forces a cut, cut Tier B to one task — never cut grading, and
  never cut the calibration check in §0.2.** A five-task study with an honest
  calibration beats a six-task study whose direct arm might be misconfigured.

---

## 13. The first honest thing to check

Before spending anything, ask whether the **direct arm can finish a Tier B task
at all** under the dollar ceiling in a single dispatch with a finite turn cap.

If it cannot, the Tier B comparison is between "an agent that ran out of budget"
and "an agent that did not". That is a real and interesting result — long-horizon
tasks are exactly where a single-dispatch scaffold should struggle — but it is a
result about **dispatch architecture under a budget ceiling**, not about
orchestration quality, and the report must say so plainly rather than banking
the win.
