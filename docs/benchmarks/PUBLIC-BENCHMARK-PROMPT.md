# Public benchmark — CherryOnTop vs. bare Claude Code on SWE-bench Verified

> Hand this whole file to a fresh agent session with the repository checked out
> clean. It produces a **publishable** benchmark report. It is deliberately
> small — one subset, one primary claim — but it meets the disclosure and
> statistical standards a sceptical reader will apply.
>
> Verified against the repository at commit `1420bc1`.

---

## 0. Read this before running anything

### 0.1 What is actually being compared

CherryOnTop **dispatches Claude Code**. `src/adapters/claude-code.ts` shells out
to `claude --print --output-format stream-json …`. So this is **not** a model
comparison and must never be presented as one.

> **The claim under test:** holding the model, the repository, the task and the
> tool permissions constant, does CherryOnTop's orchestration layer — context
> selection, model routing, delegation, the spend guard, the Action Market —
> change the **cost of solving a task** and the **probability of solving it**,
> relative to invoking Claude Code directly?

This is a **harness / scaffold comparison**. That is a legitimate, publishable
category — it is the same category SWE-agent, OpenHands, Agentless and DeepSWE's
own harness compete in. Presenting it as "CherryOnTop beats Claude" would be
false and will be caught immediately.

**Write the arms as:**
- `claude-code-direct` — Claude Code invoked directly on the task
- `cherryontop` — the same Claude Code, orchestrated by CherryOnTop

### 0.2 On DeepSWE

DeepSWE is an RL-trained open-weights coding agent (Agentica / Together, built on
Qwen3-32B) whose headline results are reported **on SWE-bench Verified**. So
"picking up the DeepSWE task" means: **evaluate on SWE-bench Verified**, which is
what this prompt does. That places your result on the same axis as DeepSWE's,
Claude's, OpenHands' and everyone else's.

**You may not claim a head-to-head with DeepSWE.** You are not running DeepSWE,
not on its hardware, not on the full 500 instances, not on the same date, and not
with the same model. Published third-party numbers may appear in the report
**only** in a clearly-labelled "external context" table with a citation and an
explicit "not run by us, not comparable as a head-to-head" note. Anything else is
a benchmark-leaderboard violation and the single fastest way to lose credibility.

### 0.3 Why the primary endpoint is cost, not resolve rate

With a small subset you cannot separate two agents on resolve rate. At n = 20, a
difference of 10 percentage points has a confidence interval roughly ±20pp — you
would be publishing noise.

But **cost is a paired, continuous, within-instance measurement**, and paired
continuous measurements have far more statistical power at small n. It is also
the thing CherryOnTop was actually built to move.

So, **pre-registered**:

| | Endpoint | Test |
|---|---|---|
| **Primary** | Cost (USD) per instance, paired | Wilcoxon signed-rank + bootstrap CI on the paired median difference |
| **Co-primary (gate)** | Resolve rate, paired | **Non-inferiority**: CherryOnTop's resolve rate must not be meaningfully worse. McNemar exact on discordant pairs |
| Secondary | Cost per *resolved* instance | Descriptive + bootstrap CI |
| Secondary | Wall-clock, total tokens, turns | Paired, descriptive |
| Exploratory | Failure taxonomy, mechanism counters | Descriptive only |

**A cost win that comes with a resolve-rate loss is a loss.** Cheaper-and-worse
is never a result. This is the gate, and it is decided before you see data.

---

## 1. Steps

### Step 0 — Preflight (free)

```bash
node --version && git rev-parse HEAD && git status --porcelain
```

```bash
npm test && npm run typecheck && npm run build
```

```bash
docker --version && kubectl get nodes && claude --version && python3 --version
```

**Gate:** Node ≥ 22. Working tree **clean**. All tests pass. Docker running (the
official SWE-bench harness needs it). `kind` cluster up. `claude` authenticated.

Record the exact Claude Code CLI version and the exact model id you will pin —
both go in the report.

### Step 1 — Fix the instance set, publicly and deterministically

Install the official harness and draw the sample:

```bash
python3 -m venv .swebench && . .swebench/bin/activate && pip install swebench datasets
```

Draw **20 instances** from `princeton-nlp/SWE-bench_Verified`, stratified by
repository, with a **fixed seed**, and write the list to
`bench/swebench/instances.json`. Publish that file verbatim in the report —
cherry-picking instances is the most common way these reports are quietly rigged,
and the only defence is showing the list and the seed that produced it.

Also record, per instance: repo, `base_commit`, problem-statement length, and the
number of `FAIL_TO_PASS` tests. These become the stratification columns.

**Do not look at any results before this file is final.**

### Step 2 — Build the two arms

Both arms must receive **identical** inputs. Build a runner that, per instance:

1. Clones the repo at `base_commit` into a fresh isolated worktree
   (reuse `bench/lib/isolation.mjs` — it already does per-goal git worktree
   isolation under `$HOME`, which the 2026-09-20 run proved is load-bearing).
2. Writes the instance's `problem_statement` **verbatim** as the task. No
   CherryOnTop-specific hints, no reformatting for one arm only.
3. Runs one arm.
4. Captures `git diff` from the worktree as the `model_patch`.
5. Tears the worktree down.

**Arm A — `claude-code-direct`:**

```
claude --print --output-format stream-json --verbose \
  --model <PINNED_MODEL> \
  --max-turns <N> \
  --allowedTools <SAME_LIST> \
  --dangerously-skip-permissions \
  "<problem_statement>"
```

**Arm B — `cherryontop`:**

```
org run "<problem_statement>" --repo <worktree> \
  --spawn --max-children 3 --budget <B>
```

### Step 3 — Equalise what must be equal, disclose what cannot be

This section is where the report's credibility is won or lost.

| Must be **identical** | Why |
|---|---|
| Instance set and `base_commit` | Pairing |
| Task text | Prompt-sensitivity is enormous |
| Model id, pinned exactly | Otherwise it's a model comparison |
| Tool allowlist | Capability parity |
| Container image / OS / Python | Environment parity |
| Network egress policy | Some instances are solvable by lookup |
| Dollar budget ceiling per instance | The fair equaliser — see below |
| Grading (official harness) | No self-report |

| Cannot be identical — **must be disclosed** | Note in the report |
|---|---|
| Number of model dispatches | CherryOnTop makes several; direct makes one. **This is the thing under test.** |
| Per-role model tiering | CherryOnTop routes plan/synthesise to a cheaper tier. Report per-role token and cost split, or a reader will assume the saving came from orchestration when some of it came from tiering |
| Turn budget semantics | `--max-turns` per dispatch vs. CherryOnTop's adaptive cap. **Equalise on dollars, not turns** |
| Scaffolding prompt text | CherryOnTop appends a system prompt. Publish it |

**Equalise on money.** Give each arm the same hard dollar ceiling per instance
and let each spend it however it likes. Equalising on turns is not meaningful
across a one-dispatch and a many-dispatch architecture, and equalising on
wall-clock penalises the arm that parallelises. Set `--budget B` for CherryOnTop
and enforce the same `B` for the direct arm by aborting it at that spend.

### Step 4 — Smoke (2 instances × 2 arms)

Run two easy instances through both arms end to end, including grading.

**Gate — stop if any is false:**
- both arms produce a non-empty `model_patch`
- the official harness grades both without erroring
- per-instance cost is recorded and non-zero for both
- the CherryOnTop arm records decisions (`org decision <nodeId>`)
- both arms' worktrees were freshly isolated (no cross-contamination)

### Step 5 — Main run (20 instances × 2 arms = 40 runs)

**Randomise arm order per instance** and record the order. Never always run A
then B — provider-side load and rate-limit state drift over a session and would
otherwise be confounded with the arm.

Log per run: cost, input/output/cache-read tokens, turns, dispatches,
wall-clock, exit state, patch size, and the validity class from
`bench/lib/validity.mjs`.

### Step 6 — Variance probe (6 instances × 2 arms × 2 extra repetitions = 24 runs)

**Do not skip this.** LLM agents are stochastic; a single run per cell is a
point estimate with unknown noise, and a reviewer will ask. Three total
repetitions on six instances is the cheapest honest answer to "how much of your
delta is run-to-run variance?".

Report within-cell standard deviation for cost and the resolve-rate flip count
(how often the same instance resolved in one repetition and not another).

### Step 7 — Grade with the official harness

Never grade by self-report or by asking a model. Run the official evaluation:

```bash
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --predictions_path <arm>.jsonl \
  --run_id <arm>-<date> \
  --max_workers 4
```

An instance is **resolved** iff all `FAIL_TO_PASS` and all `PASS_TO_PASS` tests
pass, per the harness. That is the only definition you may use.

### Step 8 — Analysis, then the report

Run the pre-registered tests from §0.3 and nothing else. Reuse
`bench/compare.mjs`: `pairRuns`, `pairedDifference`, and `signTestP` (an exact
two-sided binomial on discordant pairs — which **is** McNemar's exact test).

---

## 2. Hard rules

1. **Never present this as a model comparison.** Model is held constant; the
   harness is the variable.
2. **No head-to-head claim against DeepSWE, or any agent you did not run.**
   External numbers go in a labelled context table with citations only.
3. **Pre-register §0.3 before looking at data.** Commit it. If you change an
   endpoint afterwards, say so in the report and label the new one exploratory.
4. **Publish the instance list and the seed.** Non-negotiable.
5. **Grade only with the official harness.** No self-report, no LLM judge.
6. **Randomise arm order per instance; record it.**
7. **Only `VALID` rows enter statistics.** Infrastructure, environment,
   telemetry, snapshot failures and aborts are counted, named, excluded. If
   valid < 80% of attempted runs, the result is **inconclusive** — say so.
8. **Report the resolve-rate CI even when it is embarrassing.** At n = 20 it will
   be roughly ±20pp. State it plainly; do not round it away.
9. **Cheaper-and-worse is a loss.** The non-inferiority gate decides this.
10. **Disclose contamination.** SWE-bench Verified is public and almost certainly
    in the training data of every model involved. It does not invalidate a
    *paired harness* comparison — both arms have the same advantage — but it must
    be stated, and it does bar you from claiming absolute capability.
11. **Disclose the conflict of interest.** You built CherryOnTop. Say so, in the
    report, above the fold.
12. **Publish the raw artifacts**: every patch, every log, every cost row, the
    grading output, the scaffolding prompts, the exact commands.
13. **No tuning between arms, and no tuning mid-run.** If you fix a bug, stop,
    fix it, and restart the affected runs from scratch on the new revision —
    documenting it, as the 2026-09-20 report did.
14. **State total spend.**
15. **Never retry a product failure.** Retry infrastructure failures at most
    twice (`MAX_ENVIRONMENT_RETRIES`); a retried real failure becomes a flake.

---

## 3. Metrics to record

**Per run:** instance_id, repo, arm, repetition, arm-order, resolved (bool),
validity class, costUsd, inputTokens, outputTokens, cacheReadTokens,
cacheCreationTokens, turns, dispatches, wallSeconds, patch bytes, files touched,
exit state, model(s) per role, CLI version, revision.

> `cacheReadTokens` is usually the real bill — a measured dispatch showed 22–46
> input tokens against 1.77M cache-read. A comparison on `inputTokens` alone
> compares two rounding errors. Report all four token classes.

**Per arm:** resolve rate + 95% CI (Wilson), mean/median cost, cost per resolved
instance, total spend, mean wall-clock, token totals by class, valid-row count.

**Paired, per instance:** Δcost, Δtokens, Δturns, Δwall, resolution agreement
(both / A-only / B-only / neither — the McNemar 2×2).

**CherryOnTop-only mechanism counters** (exploratory, explain *how* not *whether*):
delegation occurred, `market_authorized` / `market_vetoed`, `execution_gate`
reasons, `delegation.scheduled` events, `recoveryReserve` engaged, knowledge rows
written/read, plan/result cache hits.

> The 2026-09-20 run's central finding was that four of seven mechanisms
> **barely fired**. Expect the same here and report it: a mechanism that did not
> fire explains nothing and gets no credit.

**Stratify by:** repository, problem-statement length, `FAIL_TO_PASS` count.

---

## 4. What good looks like

| Outcome | Conditions |
|---|---|
| **WIN** | Paired cost reduction with a bootstrap CI excluding zero, **and** resolve rate non-inferior (McNemar not significant against CherryOnTop, discordant pairs reported) |
| **NEUTRAL** | No cost difference distinguishable from noise. Report which mechanisms fired anyway |
| **LOSS** | Cost up, **or** resolve rate meaningfully down, whatever cost did |
| **INCONCLUSIVE** | valid < 80%, or variance probe shows within-cell noise ≥ the between-arm delta |

The **INCONCLUSIVE** row is the one most likely to be true at this sample size.
Publishing it is a perfectly good outcome and is far better for your credibility
than a WIN nobody can reproduce.

---

## 5. Report structure (publication standard)

```
# CherryOnTop vs. Claude Code on SWE-bench Verified (n=20 subset)

**TL;DR** — one paragraph. Arms, n, primary endpoint, result with CI, verdict.

**Conflict of interest** — the author builds CherryOnTop. Above the fold.

**What this is not** — not a model comparison; not a head-to-head with DeepSWE,
SWE-agent or OpenHands; not a full SWE-bench Verified run.

## 1. Setup
Arms, model id, CLI version, revision, dates, hardware, container image,
tool allowlist, budget ceiling, scaffolding prompts (verbatim), seed,
instance list (link to instances.json).

## 2. Method
Pairing, randomisation, isolation, budget equalisation, official grading,
pre-registered endpoints (link the pre-registration commit).

## 3. Validity
Attempted vs valid runs, excluded by class with reasons.

## 4. Primary result
Paired cost table, median Δ, bootstrap CI, Wilcoxon p, plot.

## 5. Co-primary gate
McNemar 2×2, resolve rates with Wilson CIs, non-inferiority verdict.

## 6. Secondary
Cost per resolved, tokens by class, wall-clock, turns.

## 7. Variance
Within-cell SD, resolution flips across repetitions. State how much of §4
survives it.

## 8. Mechanism attribution
Which CherryOnTop mechanisms fired, how often, and what they cost.
Explicitly list those that did NOT fire.

## 9. Failure taxonomy
Categorised failures per arm, with example instance ids.

## 10. External context (NOT head-to-head)
Published SWE-bench Verified numbers for other agents, cited, with dates and
harnesses, and an explicit statement that they were not run here.

## 11. Threats to validity
Sample size. Contamination. Single seed on 14 of 20 instances. Provider drift.
Model tiering confound. Single operator. Instance selection.

## 12. What this does and does not establish
Two short lists. Be strict.

## 13. Reproduction
Exact commands, revision, seed, artifact links.
```

---

## 6. Cost and scope control

- Smoke 4 runs · main 40 runs · variance 24 runs ≈ **68 agent runs**.
- SWE-bench Verified instances are substantially harder than this repo's internal
  goal set. Budget **$2–4 per run**; expect **$150–270** total. Set a hard
  ceiling before starting and abort against it.
- Grading is free but CPU-heavy and disk-hungry (docker images per repo). Allow
  ~40GB.
- **If the budget forces a cut, cut instances (20 → 12), never the variance
  probe and never the grading.** A 12-instance result with honest variance beats
  a 20-instance result with unknown noise.
- If the run dies mid-way: resume per instance, never report a partial arm as a
  comparison.

---

## 7. First honest thing to check

Before spending anything, ask whether the direct arm can even *finish* a
SWE-bench instance under the budget ceiling with a single `--max-turns` dispatch.
If it cannot, the comparison is between "an agent that ran out of turns" and "an
agent that did not", which is a real and interesting result — but it is a result
about **turn budget**, not about orchestration, and the report must say so rather
than banking the win.
