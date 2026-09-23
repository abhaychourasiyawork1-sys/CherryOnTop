# CherryOnTop vs. Claude Code on SWE-bench Verified (n=8 subset)

**TL;DR** — Two arms (`claude-code-direct`, `cherryontop`), both running the
same pinned model (`claude-sonnet-5`) on 8 paired SWE-bench Verified
instances, official grading, $5/instance/arm budget ceiling. Primary
endpoint (paired cost) shows no difference distinguishable from noise
(Wilcoxon p=0.46, bootstrap 95% CI on the median paired difference
[-$0.81, +$0.12], straddling zero). Resolve rate: direct 7/8 (87.5%),
cherryontop 6/8 (75%) — not statistically distinguishable at this n
(McNemar exact p=1.0), but not a demonstrated win either. A 3-instance
variance probe shows within-cell run-to-run cost noise (SD up to $1.78 on
one instance) that exceeds the entire measured between-arm cost delta.
**Verdict: INCONCLUSIVE**, per the pre-registered rule that within-cell
noise ≥ between-arm delta forces this call. This is not a null result to
apologize for — publishing "we could not tell" at n=8 is the honest
finding, and the report below says exactly what would be needed to tell.

**Conflict of interest** — the author (Abhay, working with Claude Code)
builds CherryOnTop. This benchmark was run, graded, and reported by the
same party with a stake in the outcome. No independent replication has been
done. Treat every number below accordingly.

**What this is not** — not a model comparison (the model is held constant
on both arms); not a head-to-head with DeepSWE, SWE-agent, OpenHands, or
any other published agent (none were run here — see §10); not a full
SWE-bench Verified run (500 instances); not a claim that CherryOnTop is
faster, cheaper, or more reliable than bare Claude Code in general.

---

## 1. Setup

| | |
|---|---|
| Arms | `claude-code-direct` (Claude Code CLI invoked directly), `cherryontop` (same CLI, orchestrated by CherryOnTop's `org run`) |
| Model | `claude-sonnet-5`, pinned identically on both arms: `--model sonnet` (direct) and `ORG_MODEL_EXECUTE=sonnet` (cherryontop, overriding the runtime's own model-tiering router for the execute role specifically — see Disclosures below) |
| Claude Code CLI version | `2.1.263 (Claude Code)` |
| CherryOnTop revision | `262cffd300371f68a5868f35388dd76a4a2b630e` |
| Dates | 2026-09-20 through 2026-09-21 |
| Hardware | Single operator's Linux workstation; `kind` Kubernetes cluster for CherryOnTop's sandboxed dispatches, host process for the direct arm's `claude --print` invocations |
| Container image (CherryOnTop) | `cherryontop-runner:local` |
| Tool allowlist | Unrestricted on both arms. CherryOnTop's default root-node authority is `tools: []`, which `allowedTools()` (`src/engines/enforce-tools.ts`) reads as *unrestricted*, not *no tools* — so neither arm passes `--allowedTools`, matching capability parity by construction rather than by an explicit shared list. |
| Budget ceiling | $5.00 per instance, per arm |
| Dataset | Sampled from `princeton-nlp/SWE-bench_Verified`; graded against `SWE-bench/SWE-bench_Verified` (same 500 instances, same `instance_id`s and `base_commit`s — verified by direct comparison before grading; the installed harness, `swebench` 5.0.2, requires the `image` column only present on the latter mirror) |
| Seed (instance draw) | 42 |
| Seed (arm order) | 43 |
| Instance list | [`bench/swebench/instances.json`](../../bench/swebench/instances.json) |
| Arm order | [`bench/swebench/arm_order.json`](../../bench/swebench/arm_order.json) |
| Pre-registration commits | `a7e8aae` (instance sample), `944e53f` (arm order) — both committed before any run happened |

### Scaffolding prompt (CherryOnTop arm only, published verbatim)

CherryOnTop's execute role appends this system prompt via
`--append-system-prompt` (`src/prompts/roles.ts`); the direct arm receives
no equivalent text:

```
You are one node in an accountable agent organization. Three rules govern every node:
1. Work strictly inside the mandate you were given — the tools, the budget, the scope. If a task needs more than you hold, stop and say so; do not find a way around it.
2. Produce evidence, not just a result. What you changed, what you ran, what you verified — state it so someone who was not here can check it.
3. Be honest about uncertainty and blockers. "I could not verify X" is worth more than a confident guess.

YOUR ROLE FOR THIS RUN: implementer closing one commitment.
You may use any tool available to you.
Work to the definition of done and then stop — do not gold-plate.
Your final message is the evidence that closes this commitment: state what you changed, what you verified, and what remains unchecked.
If a standing constraint blocks the most direct path, follow the constraint and say which one and where.
End your final message with a fenced ```json block in exactly this shape, after your prose:
{
  "status": "success" | "partial" | "blocked" | "needs_input" | "failed",
  "summary": "one sentence a colleague could act on",
  "findings": ["what you learned that someone else needs to know"],
  "changedFiles": ["paths you actually modified"],
  "uncertainties": ["what you could not verify"],
  "confidence": 0.0
}
It is read by machine. Keep your prose above it — that is what a person reads.
You have at most 60 turns. Track how many you have used; when you are near the limit, stop exploring and summarise what you have found and what is still unchecked. Being cut off mid-task loses your work.
```

### Direct-arm isolation (disclosed, not a full `--bare`)

The operator's personal Claude Code installation carries three plugins
(`ponytail`, `superpowers`, `mattpocock-skills`) that inject real
behavioral instructions (not just tokens — e.g. a mandate to check for a
matching skill before any response). Running the direct arm unmodified
would have contaminated the "bare Claude Code" baseline with the
operator's own customization. Fixed by passing
`--settings '{"enabledPlugins":{...:false,...:false,...:false}}'`
per invocation, confirmed (via a live test) to reduce the reported
`plugins` list to empty. This is **not** equivalent to the CLI's own
`--bare` mode, which additionally skips auto-memory and CLAUDE.md
auto-discovery — `--bare` requires `ANTHROPIC_API_KEY`, and the operator
declined API-key billing in favor of subscription-only auth. Residual
overhead from auto-memory/CLAUDE.md discovery was not fully ruled out;
worktrees are fresh external-repo clones with no prior memory history and
no CLAUDE.md of their own, which should make it small, but this was not
directly measured. CherryOnTop's arm needed no such treatment — its
dispatches run inside `cherryontop-runner:local`, a minimal image with no
plugins ever installed (confirmed via the Dockerfile).

---

## 2. Method

Both arms, per instance: fork an isolated git worktree from the cached
repo clone at `base_commit` (`bench/lib/isolation.mjs`, the same utility
the 2026-09-20 internal benchmark proved load-bearing for kind-cluster
mount visibility), hand the arm the `problem_statement` verbatim, capture
`git add -A && git diff --cached` as the `model_patch`, release the
worktree. Arm order randomized per instance (seed 43, recorded in
`arm_order.json`) so provider-side load and rate-limit state drift over the
session is not confounded with which arm ran first. Budget equalized in
dollars: the direct arm is killed by a live running-cost estimate (Sonnet
list rates, checked after every streamed turn) once it crosses $5; the
cherryontop arm gets `ORG_TASK_SPEND_CAP_USD=5`, its own native spend
guard. Grading: the official `swebench.harness.run_evaluation`, no
self-report, no LLM judge. Pre-registration: §0.3 of
[`PUBLIC-BENCHMARK-PROMPT.md`](PUBLIC-BENCHMARK-PROMPT.md), committed at
`b810fdb` before any instance was drawn.

**Scope note, agreed with the user before any spend**: the source doc
specifies 20 main instances + 6-instance variance probe (~68 runs,
$150–270). Scaled down to 8 main instances + 3-instance variance probe
(32 runs, $5/instance ceiling) by explicit user choice — "minimal, pick
few." This is the doc's own named fallback direction (it suggests 20→12
under budget pressure); this report goes further, and every section below
states what that costs in statistical power.

---

## 3. Validity

32 of 32 attempted dispatches reached a terminal state and produced a
recorded cost row — **100% attempted-to-recorded**. Two rows need a
qualifier, both investigated and confirmed to be real product behavior,
not a harness defect:

- **`pydata__xarray-6744`, cherryontop, repetition 0**: state `COMPLETE`,
  patch **0 bytes**. Event-log inspection shows 3 separate execute
  dispatches inside one node (visible `exec.rate_limit_event` entries on
  the third), consistent with the runtime's own retry behavior hitting
  provider rate limiting and converging to a no-op answer on the final
  attempt. The official grader correctly caught this as an empty-patch,
  unresolved instance — it is not silently miscounted.
- **`django__django-15252`, cherryontop, repetition 0**: state `FAILED`
  with a real, non-empty 2526-byte patch. The runtime's own DoD validation
  judged the attempt insufficient. The official grader independently
  confirms unresolved. Notably, the runtime's own `FAILED`/`COMPLETE`
  judgment does **not** always agree with the official grader in the
  other direction either — see §9.

All 32 rows enter the statistics below (Hard Rule #7's 80%-valid floor is
met trivially at 100%). No row was excluded, retried, or reclassified.

---

## 4. Primary result

Paired cost, `cherryontop` minus `direct`, repetition 0, n=8:

| instance | direct $ | cherryontop $ | Δ $ | direct resolved | cherryontop resolved |
|---|---|---|---|---|---|
| astropy__astropy-14309 | 0.55 | 0.66 | +0.12 | ✓ | ✓ |
| django__django-15252 | 2.11 | 1.04 | −1.08 | ✗ | ✗ |
| mwaskom__seaborn-3187 | 0.68 | 1.09 | +0.41 | ✓ | ✓ |
| pallets__flask-5014 | 0.27 | 0.21 | −0.06 | ✓ | ✓ |
| psf__requests-1142 | 0.23 | 0.29 | +0.06 | ✓ | ✓ |
| pydata__xarray-6744 | 0.97 | 0.16 | −0.81 | ✓ | ✗ (empty patch) |
| scikit-learn__scikit-learn-14710 | 0.87 | 0.41 | −0.46 | ✓ | ✓ |
| sympy__sympy-17139 | 0.16 | 0.22 | +0.06 | ✓ | ✓ |

- **Wilcoxon signed-rank**: statistic = 12.0, **p = 0.461** (two-sided)
- **Median paired difference**: −$0.0020 (essentially zero)
- **Mean paired difference**: −$0.220 (cherryontop cheaper on average, pulled by django and xarray)
- **Bootstrap 95% CI on the median difference** (10,000 resamples, seed 44): **[−$0.807, +$0.115]** — straddles zero
- 4 of 8 pairs cheaper on cherryontop, 4 of 8 cheaper on direct — a coin flip at the pair level

No plot is included; at n=8 a scatter of 8 points would not add information beyond the table.

**Reading this**: there is no cost difference here that survives noise.
The mean is pulled substantially by two instances (django, xarray) where
cherryontop's number is shaped by non-representative events — a spend-guard
stop on django, an empty-patch retry-storm on xarray — not by orchestration
working better in the ordinary case. The median, which two outliers cannot
dominate, is a rounding error.

---

## 5. Co-primary gate

|  | direct | cherryontop |
|---|---|---|
| Resolved | 7 / 8 (87.5%) | 6 / 8 (75.0%) |
| Wilson 95% CI | [52.9%, 97.8%] | [40.9%, 92.9%] |

McNemar 2×2 (discordant pairs):

| | cherryontop resolved | cherryontop not resolved |
|---|---|---|
| **direct resolved** | 6 | 1 (xarray) |
| **direct not resolved** | 0 | 1 (django, both arms) |

Discordant pairs: 1 (direct-only), 0 (cherryontop-only). **McNemar exact
p = 1.0** — not statistically distinguishable at n=8; the sign test the
doc names (an exact two-sided binomial on discordant pairs) is exactly
this McNemar computation, reused from `bench/compare.mjs`'s own
`signTestP` logic.

**Non-inferiority verdict**: **not demonstrated, and not ruled out.** The
one discordant pair favors direct (xarray, lost to a rate-limit retry
storm, not a task-difficulty gap — see §9). With only one discordant pair
in either direction, McNemar has essentially no power at this n; a single
different coin flip on a single instance would have produced 0 discordant
pairs and an apparently "tied" result. Per Hard Rule #9 ("cheaper-and-worse
is a loss, decided before you see data"): the resolve-rate point estimate
did drop (87.5% → 75.0%), and the cost point estimate on the median was a
wash, not a win — so even reading the point estimates generously, this
does not clear the WIN bar. It also does not clear the LOSS bar, because
neither delta is distinguishable from chance at this n.

---

## 6. Secondary

| | direct | cherryontop |
|---|---|---|
| Cost per resolved instance | $0.533 | $0.481 |
| Mean turns | 28.9 | 26.1 |
| Mean wall-clock (s) | 215 | 492 |
| Mean total tokens (input+output+cache-read+cache-creation) | 2,193,075 | 1,145,313 |

CherryOnTop's mean wall-clock is **2.3× direct's**, despite comparable
turns and roughly half the mean token volume — consistent with k8s Job
scheduling/startup overhead (pod creation, image pull checks) that a local
`claude --print` process never pays, plus the retry storms noted in §3 and
§9 inflating a couple of cells heavily. Token volume being lower on
cherryontop while turns are similar is worth a caveat, not a claim: it is
partly explained by CherryOnTop's goal-aware context selection (the
mechanism it exists to test) and partly by the same few outlier instances
that shape §4's mean — not independently decomposed here.

---

## 7. Variance

3-instance probe, 3 total repetitions each (1 from the main run + 2 extra), same arm order, same budget:

| instance | arm | costs ($) | mean | SD |
|---|---|---|---|---|
| astropy__astropy-14309 | direct | 0.55, 0.21, 1.27 | 0.675 | 0.545 |
| astropy__astropy-14309 | cherryontop | 0.66, 0.36, 0.39 | 0.470 | 0.168 |
| django__django-15252 | direct | 2.11, 1.86, 5.06 | 3.009 | **1.778** |
| django__django-15252 | cherryontop | 1.04, 0.79, 0.80 | 0.877 | 0.138 |
| mwaskom__seaborn-3187 | direct | 0.68, 1.05, 0.53 | 0.754 | 0.271 |
| mwaskom__seaborn-3187 | cherryontop | 1.09, 1.27, 1.56 | 1.310 | 0.237 |

**Resolution flips**: zero. All three instances resolved (or did not
resolve) identically across every one of their 6 graded cells (2 arms × 3
repetitions) — django never resolved in any of 6 attempts by either arm;
astropy and seaborn resolved in all 6. Resolution, at least for these
three instances, is stable; **cost is not**.

**How much of §4 survives this**: django/direct's within-cell SD ($1.78)
alone exceeds the magnitude of the *entire dataset's* mean paired cost
difference ($0.22, §4) and is comparable to the bootstrap CI's own width.
The doc's pre-registered INCONCLUSIVE trigger — "variance probe shows
within-cell noise ≥ the between-arm delta" — is met. This is not a subtle
call: one repetition of django/direct hit the $5 budget ceiling and was
cancelled at $5.06 with 139 turns, while another repetition of the same
instance, same arm, finished at $1.86. A between-arm comparison that
does not account for this is not measuring orchestration; it is measuring
which repetition happened to run.

---

## 8. Mechanism attribution

| # | Mechanism | Status | Evidence |
|---|---|---|---|
| 1 | Work-graph scheduling | **DID NOT FIRE** | Zero child nodes created across all 14 cherryontop dispatches (`SELECT count(*) FROM nodes WHERE parent_id IN (...)` = 0). No work to schedule without a fan-out. |
| 2 | Real fan-out pricing | **AUTHORIZED REPEATEDLY, NEVER MATERIALIZED** | `market_authorized: 1` fired on 6 of 14 nodes (10 total DELEGATE authorizations — some nodes re-decided multiple times). `delegation.scheduled` events: 0. Same pattern the 2026-09-20 internal benchmark found: the decision layer authorizes a split; the downstream real planning call still declines to produce one. Confirms that finding on a second, independent, materially harder task distribution (real SWE-bench problem statements, not synthetic internal goals). |
| 3 | Cross-run knowledge | **DID NOT FIRE** | `SELECT count(*) FROM knowledge` = 0 across the entire run. |
| 4 | Sibling context sharing | **DID NOT FIRE** | No node ever had a sibling — see #1. |
| 5 | Conditional recovery reserve | **NEVER OBSERVED ACTIVE** | `recoveryReserve` stayed 0 in every decision record, including on the 2 `FAILED` nodes (django, both repetitions probed). |
| 6 | Learning loop inert | **CONFIRMED INERT — correctly** | 0 `PROMOTED` policy_experiment rows. |
| 7 | Action Market veto | **FIRED — first time this project has observed it** | `market_vetoed: 1` twice, both on the same node (`mwaskom__seaborn-3187`, cherryontop, repetition 1: `decomposition_score: 3.5`, `estimatedValue: 1.2` vs. `threshold: 0.3` — the economics engine wanted to delegate; the market refused). That node self-executed instead, was judged `FAILED` by the runtime's own validation — and the official grader marked the instance **resolved** anyway (§9). |

**Spend guard** (not one of the 7, but load-bearing for §2's budget
equalization): fired (`STOP`) on `django__django-15252` in all 3 probed
repetitions and on `mwaskom__seaborn-3187` repetition 1 — the two
instances that also show the largest cost variance in §7. The guard
engaging on exactly the expensive, high-variance instances is the
behavior it exists for.

**Net**: of the four delegation-dependent mechanisms (1, 2, 4, 7),
**one fired for real this run** (7, the veto) — an improvement in evidence
over the 2026-09-20 internal benchmark, where none of the four produced
observable behavior. The other three remain unexercised. Mechanisms 3, 5,
6 are unchanged from the internal benchmark's findings: 3 and 5 silent, 6
correctly inert.

---

## 9. Failure taxonomy

**`django__django-15252`** — unresolved on both arms, every repetition
(6/6 direct+cherryontop cells, 0 resolved). The hardest instance in the
sample by a wide margin: direct's cost ranged $1.86–$5.06 across
repetitions (one repetition hit the budget ceiling and was cancelled at
139 turns), cherryontop's spend guard stopped it in all 3 probed
repetitions. Neither arm produced a resolving patch in any attempt. Not
attributable to orchestration specifically — direct failed it too, every
time.

**`pydata__xarray-6744`** — cherryontop's one clear loss relative to
direct. Root cause: a rate-limit-triggered retry storm (3 execute
dispatches inside one node, confirmed via `exec.rate_limit_event` entries)
that converged to a no-op, zero-byte patch on its final attempt. Direct
resolved this instance without incident ($0.97, 37 turns). This is an
environment-friction failure mode specific to CherryOnTop's multi-dispatch
retry behavior under rate limiting, not a capability gap on the task
itself.

**Runtime judgment vs. official grading disagree at least once, in
cherryontop's favor**: `mwaskom__seaborn-3187` repetition 1 — the
runtime's own state was `FAILED` (its internal DoD validation rejected the
self-executed answer after the Action Market vetoed delegation), but the
official SWE-bench grader marked the instance **resolved**. This means the
$1.04–$1.31 apparent "failures" implied by a runtime-state-only read of
this run would have been wrong for at least this cell; only the official
grader's verdict is used anywhere in §4–§7 above, which is exactly why
Hard Rule #5 (grade only with the official harness) exists.

No infrastructure failures, no ambiguous-failure gradings, and no grading
errors occurred on either arm across all 32 + grading runs.

---

## 10. External context (NOT head-to-head)

No other agent was run as part of this report. The numbers below are
published, third-party SWE-bench Verified results, cited for orientation
only — **not comparable** to the n=8 subset above, which used a different
(much smaller, non-random) instance sample, a different model, and a
single operator's infrastructure.

| Agent | Reported resolve rate | Source | Notes |
|---|---|---|---|
| DeepSWE (RL-trained, Qwen3-32B base) | reported on SWE-bench Verified by Agentica/Together | not independently verified here | Open-weights, different model family entirely from this report's Claude Sonnet 5 |
| Claude (various, via Claude Code / Anthropic's own harness) | published by Anthropic | not independently verified here | Closest model family to this report, still a different harness and sample |

This report makes **no claim** about how either arm here would compare to
either of the above on the full 500-instance set. Anyone tempted to
eyeball this table against §5's 75%/87.5% should not — the samples,
seeds, and conditions are incomparable by construction.

---

## 11. Threats to validity

- **Sample size.** n=8 main pairs, n=3 variance-probed. Every confidence
  interval above is wide enough to contain most plausible true effects,
  including zero and including a meaningful effect in either direction.
- **Single seed.** One draw (seed 42) determined the entire main sample.
  A different seed draws different instances and could show a different
  direction on the point estimate, even if the true effect is unchanged.
- **Stratification is one-per-repo, not population-proportional.**
  SWE-bench Verified is 46% django/django; this sample gives django the
  same weight as pallets/flask (1 of 500 instances in the full dataset).
  Generalizes across more codebases, at the cost of not reflecting the
  dataset's true composition.
- **Provider/session drift.** Both arms ran on the same operator's
  account within the same multi-hour window; rate-limit state and
  provider-side load could differ between any two dispatches regardless
  of arm order randomization.
- **Model-tiering confound, disclosed but not fully isolated.** Execute
  is pinned identically (`sonnet`) on both arms. CherryOnTop's plan/
  synthesize dispatches (when they occur — mostly they did not, per §8)
  default to a cheaper tier; the direct arm has no equivalent role
  split, being one dispatch. §6's token comparison is not decomposed by
  role for the direct arm because there is only one role to decompose.
- **Direct-arm isolation is disclosed as partial**, not full `--bare`
  (see §1). Residual auto-memory/CLAUDE.md-discovery overhead was
  reasoned about, not directly measured against a `--bare` control.
- **Single operator, single machine, single 2-day window.** No
  cross-operator, cross-hardware, or cross-time replication.
- **Contamination.** SWE-bench Verified is public and very likely present
  in the training data of the underlying model for both arms. This does
  not invalidate the paired comparison (both arms share the same
  advantage), but it bars any claim about absolute capability, and it is
  a reason the resolve rates above (75–87.5%) should not be read as a
  measure of real-world task difficulty.
- **Scope was reduced from the source protocol** by explicit user
  request (8 instances instead of 20, 3-instance variance probe instead
  of 6) before any data was seen. This is disclosed, not hidden, but it
  is the single largest lever on every confidence interval in this
  report — a 20-instance version of this exact method would very
  plausibly narrow §4's bootstrap CI enough to actually distinguish a
  direction, if one exists.

---

## 12. What this does and does not establish

**Does establish:**
- On this 8-instance sample, no cost difference between `cherryontop` and
  `claude-code-direct` survives the pre-registered statistical test.
- Resolve rate was not distinguishable between arms at this n, though the
  point estimate favored direct.
- Run-to-run cost variance for a single arm on a single instance can
  exceed the entire measured between-arm effect — a fact that should
  discourage reading any small-n agent-harness comparison (this one
  included) as more precise than it is.
- The Action Market veto (mechanism #7) fires under real conditions —
  the first time this project has observed it, on either benchmark.
- Delegation-dependent mechanisms (1, 2, 4) remain largely unexercised
  even on a harder, more realistic task distribution than the internal
  benchmark used.

**Does not establish:**
- Whether CherryOnTop is cheaper, more reliable, faster, or worse than
  bare Claude Code in general, on SWE-bench Verified, or on any other
  task population.
- Anything about DeepSWE, SWE-agent, OpenHands, or any other agent's
  relative performance.
- Anything about model capability — the model was held constant.
- Whether the mechanisms that did not fire here (1, 2, 4, 5, and mostly
  3) would fire, or would help, given more instances, different
  instances, or a different classifier threshold. No threshold was
  tuned in this run, per Hard Rule #13.
- Whether a 20-instance run of the exact same method would reach a
  different verdict. It might; this report is not that run.

---

## 13. Reproduction

```bash
git checkout 262cffd300371f68a5868f35388dd76a4a2b630e
python3 -m venv .swebench && . .swebench/bin/activate
pip install swebench datasets scipy

# Step 1 — regenerate the pre-registered sample (deterministic, seed 42)
python3 bench/swebench/draw_sample.py

# Step 2/4/5 — smoke, then the main run (order pre-registered, seed 43)
node bench/swebench/run_instance.mjs direct <instance_id> 0 5 bench/swebench/results/smoke.jsonl
bash bench/swebench/run_main.sh 5 bench/swebench/results/main.jsonl 0

# Step 6 — variance probe
bash bench/swebench/run_variance.sh 5 bench/swebench/results/variance.jsonl

# Step 7 — official grading
node bench/swebench/build_predictions.mjs bench/swebench/results/main.jsonl
python -m swebench.harness.run_evaluation \
  --dataset_name SWE-bench/SWE-bench_Verified \
  --predictions_path bench/swebench/predictions/<arm>.jsonl \
  --run_id <arm>-main --max_workers 4

# Step 8 — analysis (Wilcoxon, bootstrap CI, McNemar)
python3 bench/swebench/analyze.py
```

Artifacts: every patch (`bench/swebench/patches/`), every cost row
(`bench/swebench/results/*.jsonl`), the grading reports and raw harness
logs (`bench/swebench/grading/`), the analysis output
(`bench/swebench/analysis.json`), the pre-registered instance list and arm
order (`bench/swebench/instances.json`, `bench/swebench/arm_order.json`).

**Total spend: $26.27** across 32 measured dispatches (16 direct, 16
cherryontop), plus approximately $0.6 in small test calls made while
diagnosing the direct-arm plugin-isolation issue described in §1 (not
part of the measured comparison).
