# CherryOnTop architecture benchmark — execution prompt

> Hand this whole file to a fresh agent session with the repository checked out
> at `feat/token-efficiency-architecture`. It is written to be run **once**, on
> real paid model calls. Every command, flag and threshold in it is verified
> against the code as of commit `573db74`.

---

## 0. What you are testing and why

Seven changes landed on this branch. Each was a **finished module with no
production caller** — code that passed its tests and did nothing. The question
this benchmark answers is not "is the code good", it is **"does wiring these in
change cost, quality or latency, and which one did it".**

| # | Change | Fires only when |
|---|---|---|
| 1 | Work-graph scheduling of delegated children (serialize write-conflicts, cancel doomed siblings) | delegation reachable |
| 2 | Fan-out priced at `plan + k children + synthesis` instead of a flat `×2` | delegation reachable |
| 3 | Cross-run knowledge write path (`putKnowledge` at `publishAnswer`) | any run; pays off only on a **repeat** |
| 4 | Sibling context sharing (`previouslySelected` per commit) | ≥2 dispatches on one commit |
| 5 | Conditional recovery/verification reserve | run has a failure or a validation requirement |
| 6 | Lesson + policy lifecycle | nothing promoted yet — expect **no effect**; verify it stays inert |
| 7 | Action Market veto on delegation | delegation reachable **and** a run hits a gate |

**Four of these seven cannot fire without delegation enabled.** That is the
single most important fact in this document. See §2.

---

## 1. Steps, in order

Do not skip. Do not reorder. Each gate exists because failing it makes
everything after it unreadable.

### Step 0 — Preflight (free, ~3 min)

```bash
node --version && git rev-parse --abbrev-ref HEAD && git status --porcelain
```

```bash
npm test && npm run typecheck && npm run build && npm run bench:deterministic && npm run bench:guard
```

**Gate:** Node ≥ 22. Branch is `feat/token-efficiency-architecture`. Working
tree **clean** — a dirty tree means the recorded revision does not describe what
ran, and every row will classify `INVALID_SNAPSHOT`. All five commands exit 0.
`org` on PATH, and `claude login` or `ANTHROPIC_API_KEY` already working.

```bash
org doctor
```

**If any gate fails: STOP.** Fix it before spending a cent.

### Step 1 — Same-vs-same sanity (paid, small)

Both arms identical. This measures the harness, not the product.

```bash
ORG_BENCH_MAX_CHILDREN=3 ORG_BENCH_BUDGET_USD=5 ORG_TASK_SPEND_CAP_USD=4 \
  node bench/run.mjs efficiency --goals=rich-anchored-edit,rich-anchored-test --regimes --label=sanity
```

Then re-run with **both arms set to the same value** by editing nothing — instead
confirm from the output that the two arms differ only in the knob, and compare
their validity blocks and paired differences.

**Gate — stop if any of these is true:**
- any row is `INVALID_SNAPSHOT` or `INVALID_TELEMETRY`
- the two arms differ by >15% on cost or turns with identical configuration
- the header does **not** print `dispatch: max-children=3 budget=$5 spend-cap=$4`
- either "NOTE: delegation is NOT reachable" or "NOTE: the spend guard is NOT
  engaged" appears

### Step 2 — Confirm the mechanisms can actually fire (paid, small)

Run **one** delegating goal and inspect it before committing to the full suite.

```bash
ORG_BENCH_MAX_CHILDREN=3 ORG_BENCH_BUDGET_USD=5 ORG_TASK_SPEND_CAP_USD=4 \
  node bench/run.mjs efficiency --goals=shared-parallel-docs --regimes --label=probe
```

Then, for the node id printed:

```bash
org tree
org decision <nodeId>
org decision <nodeId> --replay
org tokens <nodeId> --json --economic
```

**Gate — every one of these must be true, or the full run tests nothing:**
- `org tree` shows **child nodes** (delegation actually happened)
- the decision record carries `market_authorized` or `market_vetoed`
- at least one `delegation.scheduled` event exists
- `--replay` reproduces every decision

If delegation did not happen, raise `ORG_BENCH_MAX_CHILDREN` and re-check
`--budget ≥ $1`. **Do not proceed to Step 3 until this gate passes.**

### Step 3 — The full paired regime suite (paid, expensive)

24 goals × 2 arms. Budget for it before starting.

```bash
ORG_BENCH_MAX_CHILDREN=3 ORG_BENCH_BUDGET_USD=5 ORG_TASK_SPEND_CAP_USD=4 \
  node bench/run.mjs efficiency --regimes --label=arch-full
```

If the session is at risk of dying mid-run, use the resumable one-arm form
instead (it appends each row as it completes and skips what it already has):

```bash
ORG_BENCH_MAX_CHILDREN=3 ORG_BENCH_BUDGET_USD=5 ORG_TASK_SPEND_CAP_USD=4 \
  node bench/regime-runner.mjs on  bench/arch-on.jsonl
ORG_BENCH_MAX_CHILDREN=3 ORG_BENCH_BUDGET_USD=5 ORG_TASK_SPEND_CAP_USD=4 \
  node bench/regime-runner.mjs off bench/arch-off.jsonl
```

### Step 4 — Repeat-run probe (paid, tiny) — tests change #3 only

Cross-run knowledge pays off only on a **second** ask. Re-run **two goals from
Step 3 in the same database**, without clearing it:

```bash
ORG_BENCH_MAX_CHILDREN=3 ORG_BENCH_BUDGET_USD=5 ORG_TASK_SPEND_CAP_USD=4 \
  node bench/run.mjs efficiency --goals=rich-anchored-edit,hidden-config-default --regimes --label=repeat
```

Compare against the same two goals' Step 3 rows. A knowledge hit should show as
fewer turns and lower `cacheReadTokens` in the `on` arm only.

### Step 5 — Report

Write the report specified in §3 and §4. Do not tune anything first.

---

## 2. Hard rules

These are not advice. Breaking any one of them invalidates the run.

1. **Never run without the three environment variables.** `ORG_BENCH_MAX_CHILDREN`,
   `ORG_BENCH_BUDGET_USD`, `ORG_TASK_SPEND_CAP_USD`. Unset `--max-children`
   defaults to **0** → no spawn authority → changes 1, 2, 7 and half of 4 are
   dead code for the entire run. Unset spend cap → the guard never engages → the
   `hard-budget` regime tests nothing. **This is the exact defect that made the
   2026-09-17 run unreadable.**
2. **Budget must be ≥ $1.** Below `MIN_AGENT_BUDGET_USD × 2` every split
   escalates instead of running. `--budget 0.5` tests escalation, not delegation.
3. **Identical grounds.** Both arms get the same goals, same revision, same
   flags, same budget, same cap, same model, same machine. The **only**
   difference is `ORG_EFFICIENCY_MODE=enabled|disabled`. The harness enforces
   per-arm ports and databases; do not override them.
4. **Never reuse a worktree or a database between arms.** The harness forks a
   fresh `git worktree` per goal per arm from one frozen revision. Do not
   dispatch against the live tree. (85 files of cross-contamination, 2026-09-17 §4.)
5. **Clean tree before starting.** Commit or stash. A dirty tree makes the
   recorded revision a lie.
6. **Only `VALID` rows enter any statistic.** Never fold `INVALID_*` or
   `ABORTED` into a mean. Never silently drop them either — report the counts.
7. **If `VALID < 60%` of attempted rows, report "inconclusive" and stop.** Do
   not quote a delta off a minority of rows.
8. **Pair per goal, never compare totals.** One large goal must not decide the
   headline for 23 small ones.
9. **Cheaper-and-worse is a regression, not a win.** Quality is a floor. If the
   `on` arm is cheaper and any rubric that passed in `off` now fails, that is a
   loss regardless of the cost delta.
10. **Do not change a threshold, weight or constant before §4 names a mechanism.**
    Tuning to make a number move is how you fit to noise.
11. **Do not promote a policy candidate from this run.** Promotion requires the
    gate in `src/learning/policy-experiments.ts` and valid paired evidence. If
    anything shows as `PROMOTED`, that is a **bug** — report it.
12. **Never retry a product failure.** The harness retries environment failures
    twice (`MAX_ENVIRONMENT_RETRIES`). Retrying a real failure turns a finding
    into a flake.
13. **Report regressions as loudly as improvements.** Say "not enough data"
    freely. `n=24` paired observations supports a direction, not a p-value.
14. **Record the actual spend.** State total dollars burned in the report.

---

## 3. Data and metrics to account for

### Per row (the harness emits all of these — do not recompute by hand)

| Field | Why it matters |
|---|---|
| `validity` + `reason` | Which rows are evidence. Everything else depends on this. |
| `state` | `COMPLETE` / `FAILED` / `CANCELLED` / `UNRUNNABLE` / `TIMEOUT` |
| `costUsd` | **Primary KPI.** |
| `turns` | The term that grows superlinearly — cost inside a dispatch re-reads the whole prefix every turn. |
| `dispatches` | Distinguishes "one long run" from "many short ones". |
| `cacheReadTokens` | Usually the real bill. A measured dispatch showed 22–46 input tokens against 1.77M cache-read — comparing `inputTokens` alone compares two rounding errors. |
| `inputTokens` / `outputTokens` | Billed, but small. Report, don't headline. |
| `wallSeconds` | Latency. Secondary unless the task values it. |
| `models` | Confirms both arms used the same tier. |
| `repositoryRevision`, `environmentFingerprint` | Pairing validity. |
| `planCacheHits`, `resultCacheHits` | Work avoided. |
| `rubric` | The quality question, scored by hand. |
| `economic[]` | Decision-level attribution — `--economic` must be on. |

### Derived, per arm

- `costPerSuccess`, `turnsPerSuccess`, `cacheReadPerSuccess` (**per success**, not
  raw totals — halving cost by failing twice as often is not an improvement)
- `excluded` count
- success rate = `COMPLETE` / valid rows

### Derived, per goal-pair (`on` minus `off`)

`ΔcostUsd`, `Δturns`, `ΔcacheReadTokens`, `ΔwallSeconds`, Δsuccess, Δquality —
plus the sign test the harness prints. Mean the **per-pair percentages**, not the
percentage of the means.

### Mechanism counters — the new ones, which decide attribution

| Signal | Where | Tells you |
|---|---|---|
| `market_authorized` / `market_vetoed` / `market_utility` | decision breakdown | Did the veto fire, and did it change an outcome? |
| `execution_gate` memory rows | memory table | Which gate: `no-spawn-authority`, `no-agent-allowance`, `single-unit-of-work`, `hard_stop`, `insufficient_budget`, `quality_floor`, `budget-floor` |
| `delegation.scheduled` events | events table | `groups`, `serializationReasons`, `sharedEvidenceIds`, `informationDuplication`, `cancelled` |
| `recoveryReserve` > 0 | economic records | Did the conditional reserve ever engage? |
| knowledge rows written / read | `knowledge` table | Did the cross-run loop close? |
| context receipt `selected` overlap between siblings | context receipts | Did sibling sharing happen? |
| `PROMOTED` policy candidates | memory table | Must be **zero**. |

### Stratify by

`regime` (7 values), `size` (small/medium/large). Report per regime — a mean over
all 24 hides the one regime that moved.

---

## 4. What to test, and what good looks like

Score each independently. A change that fires but moves nothing is a **neutral**
result and should be reported as one, not spun.

| # | Claim | Evidence that it fired | **Good** | **Bad** |
|---|---|---|---|---|
| 1 | Work-graph scheduling | ≥1 `delegation.scheduled` with a `serializationReasons` or `cancelled` entry | `shared-write-conflict` succeeds in `on`, and cancellation avoided paying for doomed children | Serialized work that was safe to parallelize → `wallSeconds` up with no quality gain |
| 2 | Real fan-out pricing | `market_utility` present; delegation width varies with allowance | Fewer pointless 2-way splits; `costPerSuccess` down on `shared-*` | Delegation stops entirely → check it is the veto, not the estimate |
| 3 | Cross-run knowledge | knowledge rows written in Step 3, read in Step 4 | Step 4 repeat: turns and `cacheReadTokens` down in `on` only | Rows written, never read → write path works, read path does not |
| 4 | Sibling context sharing | sibling receipts share paths | `shared-information` regime's **+99% regression narrows**; `cacheReadTokens` down | No overlap → the memo is not reaching siblings |
| 5 | Conditional reserve | `recoveryReserve` > 0 on failing runs, `== 0` on clean ones | Clean runs unaffected (invariant #29 holds); failing runs keep budget to recover | Non-zero on healthy runs → the condition is wrong |
| 6 | Learning loop inert | zero `PROMOTED` candidates | **No measurable effect.** Lessons may reach `CANDIDATE`/`VALIDATING` | Anything `ACTIVE` or `PROMOTED` → a safety bug, report immediately |
| 7 | Action Market veto | `market_vetoed = 1` at least once | `hard-budget` / `strategy-failure`: a fan-out refused on a run already over budget or stopped | Veto fires on healthy runs → too aggressive, report the gate |

### The three regressions this run must specifically re-test

1. **`shared-information` was +99%.** Changes 1 and 4 target it. Did it narrow?
   By how much, and is `n` per regime (3 goals) enough to say anything? *Probably
   not — say so.*
2. **`hard-budget` was 61 → 146 turns.** The addendum proved the guard was
   **never engaged** — the cap was unset. With `ORG_TASK_SPEND_CAP_USD=4` set,
   **does it reproduce at all?** If not, it was never a runtime defect and the
   original finding should be formally retracted.
3. **`strategy-failure` stopped differently from baseline.** With the reserve
   live, does `on` now recover where it previously stopped?

### Overall verdict — state exactly one

- **WIN** — `costPerSuccess` down, no rubric regressed, no hard constraint
  breached, effect visible in ≥2 regimes.
- **NEUTRAL** — no effect beyond noise. Say which mechanisms fired anyway.
- **REGRESSION** — cost up, or any rubric that passed now fails. Name the
  mechanism from §3.
- **INCONCLUSIVE** — `VALID < 60%`, or the Step 2 gate never passed. Say what
  broke.

---

## 5. Report template

```
## Verdict: WIN | NEUTRAL | REGRESSION | INCONCLUSIVE
One paragraph, plain English. Total spend: $X.

## Configuration
revision / max-children / budget / spend-cap / model / arms / date
delegation reachable: yes|no    spend guard engaged: yes|no

## Validity
valid N of M. Excluded: INVALID_INFRA n (reasons), INVALID_ENV n, ...

## Did the mechanisms fire?
Table of the 7 changes: FIRED / DID NOT FIRE / N/A, with the counter proving it.
A change that did not fire explains nothing and gets no credit.

## Paired results, per regime
regime | n | Δcost% | Δturns% | ΔcacheRead% | Δwall% | Δsuccess | Δquality

## Attribution
For each regression: which mechanism, with the counter that shows it.

## The three re-tests
shared-information / hard-budget / strategy-failure — one paragraph each.

## Quality
Rubric pass/fail per goal per arm. Any rubric that passed in off and failed in on.

## What this does NOT establish
Be explicit about sample size and what stayed untested.

## Recommended next action
No tuning proposals unless attribution named a mechanism.
```

---

## 6. Cost control

- Step 1 ≈ 4 goal-runs. Step 2 ≈ 2. Step 3 ≈ 48. Step 4 ≈ 4.
- The `off` arm's broad-review goal alone measured **26% of a five-hour usage
  window**. Running everything can exhaust the window and produce half a
  comparison.
- If the window runs out mid-Step-3: use `regime-runner.mjs`, which resumes.
  **Never** report a half-finished arm as a comparison.
- Abort and report if spend exceeds your ceiling. A partial run honestly
  reported beats a complete run nobody can trust.
