# Full Architecture vs Baseline — initial comparison

**Status: one paid matched pair has been run. It shows a large regression, and
it exposed two defects that made the primary metric uncomputable.** The rest of
the matrix has not been paid for.

The headline, stated before anything else: on `typo-fix`, Full Architecture took
**six times the turns, 5.7× the cache-read tokens, 90% more money and eleven
times the wall-clock** of Baseline. `n=1`, so this is a direction and not a
magnitude — but it is a direction in every metric at once.

| | |
|---|---|
| Candidate commit | `0dfa6d4` (smoke pair ran at `8b9de76`, before the two defect fixes) |
| Branch | `feat/token-efficiency-architecture` |
| Baseline frozen at | `935f5ac76509d24de97809c558c4606ae90a777b` ([record](../superpowers/implementation-baseline-2026-09-14.md)) |
| Node | v22.22.2 |
| Policy generation | `ctx-1/exec-1`, decision engine `dec-1` |
| Unit suite | 150 files, 1712 tests, passing |
| Integration / e2e | 12 and 1, passing |
| Coverage | 81.9% statements, 76.2% branches (thresholds 70 / 65) |

---

## 1. The paid smoke run

```bash
node bench/run.mjs efficiency --goals=typo-fix --label=econ-smoke
```

Commit `8b9de76`, one goal, both arms, isolated ports (7811 / 7816) and
databases. Both arms reached `COMPLETE`. Raw rows in `bench/econ-smoke.json`.

| | Baseline | Full Architecture | delta |
|---|---:|---:|---:|
| turns | 3 | 18 | **+500%** |
| billed tokens | 1,181 | 6,258 | **+430%** |
| cache-read tokens | 97,211 | 550,489 | **+466%** |
| cost | $0.1518 | $0.2878 | **+90%** |
| wall-clock | 39s | 448s | **+1,049%** |
| state | COMPLETE | COMPLETE | — |
| orchestration overhead | 0.00% | 1.98% | — |

The harness's own verdict: `regressed`, on p95 latency, with tokens per
successful task and quality both `inconclusive`.

### What this does and does not say

**Does:** on a tiny anchored edit, the Full arm made the agent work six times
harder for the same outcome. Every metric moved the same way. The orchestration
overhead itself was 1.98% — the control plane is not what cost the tokens.

**Does not:** that this generalises. `n=1`, and the harness declines to say
anything beyond direction below five pairs — correctly.

**Confound, and it is a serious one.** `ORG_EFFICIENCY_MODE` is a single switch
over context selection, model routing, conditional synthesis *and* the economic
control plane. Baseline therefore sends the **whole repository map**; Full sends
a selected ~400 tokens. So this pair does not isolate the economic layer — it
measures the entire efficiency stack, most of which predates this work.

### The most likely mechanism, stated as a hypothesis

The Full arm was handed 403 estimated context tokens and took 18 turns. The
Baseline arm was handed the full map and took 3. That is precisely the failure
this repository's own documentation warns about:

> A smaller prompt that sends the agent hunting for what it was not given is
> more expensive, not less.

If that is what happened, the selected context for a tiny anchored edit is *too
small*, and the saving on the prompt was paid back many times over in turns.
Settling it needs the component telemetry across more than one goal — which is
what the frozen population and the regime suite are for.

**No tuning has been done from this.** One sample names a direction. See the
[tuning log](2026-09-14-policy-tuning-log.md) for why that is not enough.

### Two defects it exposed

Both arms reported `success rate: 0.000` despite both completing, so tokens per
successful task could not be computed at all. Two causes, both now fixed with
regression tests:

1. **Ordering.** `recordEfficiency` validates a run against its definition of
   done and ran *before* `closeDefinitionOfDone`. Every item read `unverified`,
   every run was downgraded to `partial`. Invisible in unit tests, whose
   fixtures had no definition of done to close.
2. **A global quality floor.** At 0.7, a task that edits a file and runs no test
   could never pass — V1 evidence is worth 0.5. That is most of a benchmark
   corpus. The floor now comes from the task's own `verificationNeed`.

This is the smoke test doing its job: it was run to find out whether the harness
works end to end, and it found two reasons it did not.

---

## 2. What else has been measured

### Tokens per successful task — **not measured**

The primary metric. The smoke run could not compute it (see the defects above,
now fixed); a re-run would. Reporting a proxy here would be exactly the
substitution this report exists to avoid.

### What the control plane costs — measured

The number the whole economic layer stands or falls on, and the one that *is*
measurable without a model, because the decision layers are deterministic
arithmetic over data already in memory.

```
| run            | opportunity | work done           | decision | tokens | of task spend |
|----------------|-------------|---------------------|----------|--------|---------------|
| healthy run    | no          | screen only         | continue | 4      | 0.007%        |
| struggling run | yes         | screen + evaluation | recover  | 128    | 0.107%        |
```

Reproduce with `npm run bench:deterministic`.

Read as: on a run that is going well the control plane costs four tokens and
declines to look further — the deep path, and every lookup in it, does not
happen. On a run in trouble it pays for a full evaluation and still costs about
a tenth of one percent of what the task has spent.

**What this does and does not establish.** It establishes that the orchestrator
is cheap. It does **not** establish that it is *useful* — that its interventions
save more than they cost — which is a question only the paid run answers.

### Information economics — measured

```
| file                     | why it is a candidate                                   | to send | to rediscover | net value |
|--------------------------|---------------------------------------------------------|---------|---------------|-----------|
| src/auth/session.ts      | anchor                                                  | 12      | 600           | 18,988    |
| src/auth/session.test.ts | imports:src/auth/session.ts test-of:src/auth/session.ts | 24      | 6,000         | 135,976   |
| src/auth/store.ts        | imported-by:src/auth/session.ts                         | 18      | 4,200         | 95,182    |
```

The covering test — the neighbour nothing lexical ever finds — prices highest,
which is the asymmetry the context layer was built to exploit. The unrelated
billing file is not a candidate at all.

**Hypothesis, not a finding.** These are model outputs over fixtures. Whether
the discovery model's constants (3 turns, 2,000 tokens a turn) match this
runtime's real behaviour is unknown, and the paid run is what would calibrate
them. They were chosen conservatively — understating rediscovery cost makes the
planner include *less*, not more.

### Context selection — measured, and unchanged in kind from the frozen baseline

```
| goal                   | lexical tokens | planner tokens | ceiling used | files kept | newly reached |
|------------------------|----------------|----------------|--------------|------------|---------------|
| anchored one-file edit | 5,998          | 1,196          | 20%          | 402 -> 105 | 0             |
| anchored with callers  | 5,998          | 2,569          | 43%          | 402 -> 190 | 1             |
| names an area only     | 5,998          | 2,942          | 49%          | 402 -> 180 | 14            |
| names nothing specific | 37             | 37             | 1%           | 0 -> 0     | 0             |
```

### Guard behaviour — measured

`npm run bench:guard` over six trajectories: 0 false positives (work killed
that was going somewhere) and 0 false negatives (doomed runs left spending).

### Behaviour change against the frozen baseline receipts — measured, **confounded**

The baseline record captured four goal shapes. Re-running them on this commit:

| Goal shape | Candidates then → now | Selected then → now | Est. tokens then → now |
|---|---:|---:|---:|
| tiny (`Fix a typo in README.md`) | 6 → 6 | 6 → 6 | 392 → 395 |
| medium (`Add a unit test for … scoreDelegation`) | 31 → 51 | 15 → 32 | 621 → 983 |
| broad (`Review the codebase and find bugs`) | 2 → 2 | 1 → 1 | 426 → 469 |
| low-confidence (`make it better`) | 0 → 0 | 0 → 0 | 409 → 410 |

**This comparison is confounded and must not be read as a clean before/after.**
The selector is being run against *this repository*, and this repository grew by
roughly forty files during the implementation. Some of the rise in candidates and
selections is the tree, not the policy.

What can still be read off it:

- The **tiny** and **low-confidence** shapes are unchanged, which is the useful
  negative result: a goal with one obvious answer and a goal with no purchase at
  all both behave exactly as they did.
- The **broad** shape still finds two candidates and still tops out at
  `0006_groovy_bug.sql`, matched on the word "bug" in a migration filename. The
  information-poor regime is **not fixed** by this work. Candidate *generation*
  is the limit — structural relevance is measured from anchors, and a goal with
  no anchors gets no structural seeds — and nothing in this plan changed that.
  It is the most concrete known gap.
- The **medium** shape selects proportionally more (48% of candidates → 63%).
  Part of that is the root-cause fix in `explorationAvoided`, where a
  lexically-matched file was scored as costing nothing to rediscover — i.e. "the
  agent already knows about it", which is false. Whether selecting more is an
  improvement is **exactly** what the paid run settles, and it is recorded here
  as a change rather than as a win.

To de-confound it, re-run the receipts against the frozen baseline commit
(`935f5ac`) and this one over the *same* checkout of a third repository.

---

## 3. What is not measured

Everything in the acceptance contract:

| Metric | Status |
|---|---|
| tokens per successful task | not measured |
| success rate | not measured |
| quality score | not measured |
| latency | not measured |
| initial context tokens (live) | not measured |
| exploration / evidence / validation / recovery tokens | not measured |
| duplicated-information tokens | not measured |
| orchestration overhead (live) | not measured |
| optimization ROI | not measured |
| beneficial intervention rate | not measured |
| memory net value | not measured |

The telemetry to produce every one of them exists and is wired; what is missing
is a run.

---

## 4. Why the rest was not run

The harness dispatches real, paid model calls. The smoke pair alone cost $0.44
and eight minutes for a single goal. The frozen population is seven goals across
two arms; the regime suite is twenty-four across two — and the recorded
measurement in this repository is that one *large* goal in one arm consumed 26%
of a five-hour usage window.

Spending that is the repository owner's decision, not the implementer's, and it
is not reversible once spent. The smoke run was authorised explicitly; the rest
was not.

**The smoke pair predates the two defect fixes.** A re-run on the current commit
would produce a computable success rate and therefore a real tokens-per-success
number, which the recorded pair cannot give.

---

## 5. How to run the rest

Prerequisites, all present on the machine this was prepared on:

```bash
kind get clusters          # org-local
kubectl get nodes          # Ready
command -v org             # on PATH
ls ~/.claude/.credentials.json
```

Then, cheapest first:

```bash
# One goal, both arms. The smallest thing that produces a real paired number.
node bench/run.mjs efficiency --goals=typo-fix --label=econ-smoke

# The frozen population, both arms. This is the headline comparison.
node bench/run.mjs efficiency --label=econ-full

# The regime suite. Larger, and what says *where* the policy is wrong.
node bench/run.mjs efficiency --regimes --label=econ-regimes
```

Each writes `bench/<label>.json` containing per-goal rows, the economic
records, the reproducibility metadata, and the paired differences. The harness
prints the acceptance verdict itself.

**Before reading any result**, check the metadata block. If the harness printed
*"this run is not fully reproducible"*, the numbers are still informative and
are not a measurement — a dirty tree or two policy generations in one run means
the revision does not describe what ran.

---

## 6. How to read the result when it exists

In this order, and not in any other:

1. **Tokens per successful task.** The primary metric.
2. **Quality and success rate, beside it.** A cheaper incorrect task is a
   regression. If quality was not scored on the Full arm, the comparison fails —
   silence is not a pass.
3. **Tasks stopped.** A cheap arm full of stopped tasks is not a cheaper arm.
4. **Where the spend went.** Initial context, exploration, evidence, validation,
   recovery, duplication. This is what makes a regression *attributable* rather
   than merely visible. Without it a token delta is a correlation.
5. **Orchestration overhead.** If this is not small, none of the savings above
   are real.

### Attribution, if there is a regression

| If this rose | Look at |
|---|---|
| initial context tokens | `context/selector.ts` — the economic gate, and `explorationAvoided` |
| exploration tokens | the gate is pruning too hard; check whether widening fired |
| evidence acquisition tokens | `context/evidence-actions.ts` — re-pricing at the boundary |
| recovery tokens | `recovery/engine.ts` — retries justified too easily |
| duplicated-information tokens | `execution/workstreams.ts` — parallelism winning when it should not |
| validation tokens | `validation/engine.ts` — escalating past the cheapest sufficient level |
| orchestration overhead | `decision/orchestration-loop.ts` — the cadence backoff |

### What not to do with it

**Do not tune from a single favourable sample.** The plan forbids it and the
sample size makes it meaningless: the harness will not call anything
significant, and neither should a reader. One run names a direction. Tuning
belongs in [the tuning log](2026-09-14-policy-tuning-log.md), under the rules
recorded there.
