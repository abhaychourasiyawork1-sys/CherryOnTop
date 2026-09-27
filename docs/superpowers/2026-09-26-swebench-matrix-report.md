# SWE-bench Verified matrix — full report (2026-09-26)

Branch `feat/system1-laya-decision-architecture`, base commit `69a0a4a` (perf: cut CherryOnTop cost below Claude Code on SWE-bench). Fixes described here landed on top at commit `0a6f7cc`.

Report artifact (interactive, per-run dot plot + resolve grid): https://claude.ai/artifact/1z5UJXg3sRwK2kUp8DqWxn

---

## 1. What was run

| | |
|---|---|
| Benchmark | SWE-bench Verified (official harness, `bench/swebench/grading/grade_matrix.sh`) |
| Instances (6) | `pallets/flask-5014`, `psf/requests-1142`, `mwaskom/seaborn-3187`, `scikit-learn/scikit-learn-14710`, `sympy/sympy-17139`, `pydata/xarray-6744` |
| Reps | 3 (`81`, `82`, `83` — offset to avoid colliding with earlier benchmarks' patches) |
| Arms | `direct` (Claude Code alone), `cherryontop` (CherryOnTop + Laya live) |
| Model | `claude-sonnet-5`, both arms |
| Budget | $3.00/run |
| Turn cap | 80 turns, both arms (`MAX_TURNS_DIRECT` in `bench/swebench/run_instance.mjs`) |
| Total runs | 36 (6 × 3 × 2) |
| Total spend | $13.63 |
| Driver | `MATRIX_NAME=final MATRIX_REPS=81,82,83 node bench/swebench/run_matrix.mjs 3`, launched detached (`setsid nohup`) |
| Wall-clock | ~05:03 UTC → ~08:09 UTC (≈3h, including grading) |

**Scope note:** the original design was 3 arms × 6 × 3 = 54 runs (also running `cherryontop-nolaya`, Laya disabled). Partway through rep 81 the user asked to drop the Laya-off arm; the in-flight run was stopped by PID, the one already-recorded `cherryontop-nolaya` row (and its patch file) was deleted, and the driver was relaunched with `MATRIX_ARMS=direct,cherryontop`. All reported numbers below are for the 2-arm, 36-run design only.

### Preflight checks (all done before launch)

1. **Usage window** — probed with `claude -p --model claude-haiku-4-5-20251001 --max-turns 1 --output-format stream-json --verbose "Reply OK"`. Result: `five_hour: 0.32`, `seven_day: 0.93` (above the user's ~70% go/no-go line). Flagged to the user; user chose "launch anyway."
2. **Disk** — 33GB free on `/` (≥30GB required), 9.8GB reclaimable in Docker build cache/dangling images (not pruned, wasn't needed).
3. **Build** — `npm test`: 193 test files / 2191 tests passed. `npm run build`: clean. `sg docker -c "bash scripts/build-runner-image.sh"`: image built, CLI pinned to 2.1.280 (host version at the time).
4. **Cluster** — `org doctor`: all green (kind cluster reachable, runner image loaded, Laya ready, haiku+sonnet callable). `org-exec` namespace active. Sandboxes idle (0 active / 0 queued / max 2).
5. **Credentials** — OAuth token had 71 minutes left (>40 min required); the driver's own `refreshTokenIfNeeded()` renews it automatically during a long run.

---

## 2. Headline results

| Metric | Claude Code (`direct`) | CherryOnTop + Laya (`cherryontop`) |
|---|---|---|
| Runs | 18 | 18 |
| Resolved | 16/18 (88.9%) | **18/18 (100%)** |
| Mean cost/run | $0.4112 | **$0.3461** |
| Median cost/run | $0.3094 | $0.3411 |
| Total cost | $7.402 | $6.230 |
| Cost per resolved task | $0.4626 | **$0.3461** |
| Mean turns/run | 16.17 | 23.94 |
| Mean tokens/run | 970,265 | 823,358 |
| Mean wall-seconds/run | 144.2 | 181.8 |
| Laya judgments (fallbacks) | — | 7 (0) |
| Planner runs (haiku plan dispatch) | 0 | 3 |
| Real delegations (children spawned) | 0 | **0** |

### Paired differences (n=18, same instance+rep pair, 95% bootstrap CI)

| Comparison | Metric | Mean diff | Relative | 95% CI |
|---|---|---|---|---|
| cherryontop − direct | Cost/run | −$0.0651 | −15.8% | [−$0.138, +$0.010] (crosses zero — not significant at n=18) |
| cherryontop − direct | Turns/run | +7.78 | +48.1% | [+3.0, +13.06] (entirely positive — significant) |
| cherryontop − direct | Tokens/run | −146,908 | −15.1% | [−367,015, +78,912] (crosses zero) |
| cherryontop − direct | Resolved rate | +0.111 (+11 pts) | — | [0, +0.278] (boundary-significant) |

### Per-instance breakdown

| Instance | Arm | Resolved | Mean cost | Mean turns | Mean tokens |
|---|---|---|---|---|---|
| seaborn-3187 | direct | 1/3 | $0.6409 | 18.33 | 1,146,768 |
| seaborn-3187 | cherryontop | 3/3 | $0.5320 | 43.00 | 1,567,239 |
| flask-5014 | direct | 3/3 | $0.2434 | 13.33 | 676,962 |
| flask-5014 | cherryontop | 3/3 | $0.1348 | 13.33 | 316,916 |
| requests-1142 | direct | 3/3 | $0.2223 | 10.00 | 508,928 |
| requests-1142 | cherryontop | 3/3 | $0.2512 | 24.00 | 673,596 |
| xarray-6744 | direct | 3/3 | $0.6687 | 24.00 | 1,581,349 |
| xarray-6744 | cherryontop | 3/3 | $0.4886 | 25.00 | 980,804 |
| scikit-learn-14710 | direct | 3/3 | $0.5287 | 24.00 | 1,543,948 |
| scikit-learn-14710 | cherryontop | 3/3 | $0.5391 | 27.67 | 1,132,802 |
| sympy-17139 | direct | 3/3 | $0.1635 | 7.33 | 363,638 |
| sympy-17139 | cherryontop | 3/3 | $0.1310 | 10.67 | 268,789 |

**Who wins where:** CherryOnTop wins outright on accuracy (only `seaborn-3187` differs, and CherryOnTop resolves it 3/3 vs Claude Code's 1/3). On cost, CherryOnTop wins on `flask`, `xarray`, `sympy`; Claude Code is slightly cheaper on `requests` (Python-2.7 environment friction, see §5.2) and roughly tied on `scikit-learn`.

### Full per-cell data

| Instance | Arm | Rep | Cost | Turns | Tokens | Resolved |
|---|---|---|---|---|---|---|
| seaborn-3187 | cherryontop | 81 | $0.3258 | 32 | 872,234 | ✓ |
| seaborn-3187 | cherryontop | 82 | $0.7955 | 60 | 2,459,264 | ✓ |
| seaborn-3187 | cherryontop | 83 | $0.4746 | 37 | 1,370,219 | ✓ |
| seaborn-3187 | direct | 81 | $0.6567 | 8 | 584,128 | ✓ |
| seaborn-3187 | direct | 82 | $0.5751 | 23 | 1,359,445 | ✗ |
| seaborn-3187 | direct | 83 | $0.6910 | 24 | 1,496,732 | ✗ |
| flask-5014 | cherryontop | 81 | $0.1356 | 12 | 284,944 | ✓ |
| flask-5014 | cherryontop | 82 | $0.1430 | 15 | 359,912 | ✓ |
| flask-5014 | cherryontop | 83 | $0.1259 | 13 | 305,893 | ✓ |
| flask-5014 | direct | 81 | $0.2563 | 14 | 707,767 | ✓ |
| flask-5014 | direct | 82 | $0.2531 | 13 | 675,132 | ✓ |
| flask-5014 | direct | 83 | $0.2207 | 13 | 647,986 | ✓ |
| requests-1142 | cherryontop | 81 | $0.3565 | 33 | 1,010,084 | ✓ |
| requests-1142 | cherryontop | 82 | $0.1778 | 17 | 432,547 | ✓ |
| requests-1142 | cherryontop | 83 | $0.2192 | 22 | 578,157 | ✓ |
| requests-1142 | direct | 81 | $0.2186 | 9 | 456,470 | ✓ |
| requests-1142 | direct | 82 | $0.2191 | 10 | 503,987 | ✓ |
| requests-1142 | direct | 83 | $0.2291 | 11 | 566,327 | ✓ |
| xarray-6744 | cherryontop | 81 | $0.5808 | 29 | 1,206,414 | ✓ |
| xarray-6744 | cherryontop | 82 | $0.4919 | 23 | 901,687 | ✓ |
| xarray-6744 | cherryontop | 83 | $0.3932 | 23 | 834,310 | ✓ |
| xarray-6744 | direct | 81 | $0.9385 | 30 | 2,133,658 | ✓ |
| xarray-6744 | direct | 82 | $0.5598 | 22 | 1,382,699 | ✓ |
| xarray-6744 | direct | 83 | $0.5077 | 20 | 1,227,690 | ✓ |
| scikit-learn-14710 | cherryontop | 81 | $0.6417 | 34 | 1,245,840 | ✓ |
| scikit-learn-14710 | cherryontop | 82 | $0.5899 | 28 | 1,330,683 | ✓ |
| scikit-learn-14710 | cherryontop | 83 | $0.3856 | 21 | 821,882 | ✓ |
| scikit-learn-14710 | direct | 81 | $0.3625 | 16 | 930,491 | ✓ |
| scikit-learn-14710 | direct | 82 | $0.7282 | 33 | 2,257,659 | ✓ |
| scikit-learn-14710 | direct | 83 | $0.4953 | 23 | 1,443,693 | ✓ |
| sympy-17139 | cherryontop | 81 | $0.1594 | 13 | 334,991 | ✓ |
| sympy-17139 | cherryontop | 82 | $0.1426 | 11 | 278,657 | ✓ |
| sympy-17139 | cherryontop | 83 | $0.0911 | 8 | 192,718 | ✓ |
| sympy-17139 | direct | 81 | $0.1659 | 7 | 345,386 | ✓ |
| sympy-17139 | direct | 82 | $0.1691 | 7 | 349,025 | ✓ |
| sympy-17139 | direct | 83 | $0.1555 | 8 | 396,503 | ✓ |

Raw data: `bench/swebench/results/final.jsonl` (per-run rows, full economic/token detail), `bench/swebench/results/final-analysis.json` (computed stats above), `bench/swebench/results/final.log` (driver's timestamped event log).

---

## 3. Comparison to the 2026-09-25 baseline

Baseline: `bench/swebench/results/matrix.jsonl` / `matrix-analysis.json`, same 6 instances × 3 reps, run **before** the 2026-09-25 cost-gap fixes (see `docs/superpowers/2026-09-25-swebench-cost-root-cause.md`).

| Metric | Baseline direct | Baseline cherryontop+Laya | Today direct | Today cherryontop+Laya |
|---|---|---|---|---|
| Resolved | 16/18 | 18/18 | 16/18 | 18/18 |
| Mean cost/run | $0.4626 | $0.5181 | $0.4112 | $0.3461 |
| Median cost/run | $0.3789 | $0.4978 | $0.3094 | $0.3411 |
| Cost/resolved task | $0.5205 | $0.5181 | $0.4626 | $0.3461 |
| Mean turns | 17.39 | 28.33 | 16.17 | 23.94 |
| Laya judgments | 0 | 11 | 0 | 7 |

**The reversal:** at baseline, CherryOnTop was **+12% pricier** than Claude Code per run ($0.518 vs $0.463). Today it is **−16% cheaper** ($0.346 vs $0.411) — a swing driven almost entirely by CherryOnTop getting cheaper (mean cost −33%, cost-per-resolved −33%), not by Claude Code getting worse. Claude Code's own numbers also improved slightly (mean cost −11%), which reads as ordinary run-to-run variance across different instance/rep draws, not a code change on that side. The turns gap narrowed from +10.9 to +7.8 but did not close — see §4.3.

This improvement is the compounding effect of the fixes already landed on this branch before today's run: the SWE-bench cost-gap fixes (`docs/superpowers/2026-09-25-swebench-cost-root-cause.md`, F1–F12), the token/turn review (`docs/superpowers/2026-09-26-token-and-turn-review.md`, sandbox CLI tool/skill/agent stripping), and the two fixes described in §6 of this report (found *from* today's run, not yet reflected in it — a future rerun should show the next increment).

---

## 4. Why the numbers look the way they do

### 4.1 Why CherryOnTop is cheaper overall

Not because it does less work — it takes 48% *more* turns. It's cheaper per turn:

| Arm | Tokens/turn (mean) | Cost/turn (mean) |
|---|---|---|
| direct | 57,382 | $0.0254 |
| cherryontop | 31,914 | $0.0145 |

CherryOnTop's sandbox runs the CLI with a stripped tool/skill/agent surface (`--tools <coding set>`, `--disable-slash-commands`, `CLAUDE_CODE_DISABLE_{AUTO_MEMORY,BUNDLED_SKILLS,EXPLORE_PLAN_AGENTS}` — landed 2026-09-26 per the token/turn review), so every turn re-reads a much smaller cached system prompt than plain Claude Code, which carries its full 17-tool/15-skill/5-agent surface on every turn. 43% cheaper per turn, at 48% more turns, nets out to ~16% cheaper overall (0.57 × 1.48 ≈ 0.84).

### 4.2 Why turns are still higher (the unclosed lever)

+7.78 turns/run, 95% CI [+3.0, +13.06] — entirely positive, i.e. real, not noise. Two identified contributors (§5, §6):

- Laya's decomposability judge occasionally still fires on single-issue tasks, adding a wasted planning dispatch (fixed today, see §6.1 — will reduce this in a future rerun, not reflected in today's numbers).
- Environment-discovery friction on `requests-1142` specifically (fixed today, see §6.2).

Both fixes target turns, not cost directly — expect this gap to narrow further on a rerun, not the cost number to move much (the wasted planning calls are cheap in dollars, ~$0.004–0.03 each; it's turns and latency they cost).

### 4.3 Delegation: measured zero

Across all 18 `cherryontop` runs, **zero** ever spawned a child node — every run, including the 7 where Laya was asked and 6 of those returned `DELEGATE`, ended up self-executing as a single agent. Verified directly against `~/.org/state.db`:

```sql
-- for each of the 7 Laya-consulted node ids:
SELECT count(*) FROM nodes WHERE parent_id = '<node_id>';
-- always 0
```

State-machine trace for a `DELEGATE`-then-self-execute run (seaborn rep82, node `d720ba0b-...`):
```
CREATED → INTELLIGENCE_GATE → EXECUTION_DECISION → DELEGATE → (plan.result, haiku) → SELF_EXECUTE → VALIDATE → COMPLETE
```
For a `requests` run that skipped the planning dispatch entirely (node `7fd9a65e-...`):
```
CREATED → INTELLIGENCE_GATE → EXECUTION_DECISION → DELEGATE → SELF_EXECUTE → VALIDATE → COMPLETE
```
(No `plan.*` events for the second pattern — the planning dispatch was itself skipped for a reason not fully traced in this session; worth a follow-up if it recurs.)

This is expected given the benchmark: SWE-bench Verified issues are single bug reports that mostly don't decompose. It also means CherryOnTop's cost advantage in this run has nothing to do with parallelizing work — it's purely the lighter per-turn prompt (§4.1).

---

## 5. Outliers — root-caused via `~/.org/state.db`

Defined as >1.5× the run's own instance+arm median cost.

| Instance | Arm | Rep | Cost | Turns | Ratio to median | Root cause |
|---|---|---|---|---|---|---|
| seaborn-3187 | cherryontop | 82 | $0.7955 | 60 | 1.68× | Laya false-positive decompose + genuinely hard bug (§5.1) |
| requests-1142 | cherryontop | 81 | $0.3565 | 33 | 1.63× | Laya false-positive decompose + Python-2.7 env friction (§5.1, §5.2) |
| xarray-6744 | direct | 81 | $0.9385 | 30 | 1.68× | Unknown — no trace available (§5.3) |

### 5.1 Laya decomposability false positives (root of §6.1's fix)

Node `7fd9a65e-d9c1-4941-8543-6eba98d9dc78` (`requests-1142` cherryontop rep81) — `decision.made` payload:
```json
{"outcome":"DELEGATE","breakdown":{
  "breadth_terms":1,"separate_items":0,"distinct_work_types":1,"named_single_targets":0,
  "decomposition_score":2,"split_score":0,"coherent_single_task":1,
  "explicit_split_request":0,"system1_asked":1,"system1_threshold":0.3333,
  "system1_p_decomposable":0.5943,"threshold":0.3,"score":0.3}}
```
The heuristic (`assessDecomposition`) had already correctly scored this `coherent_single_task: 1` — its own signal for "this doesn't split." But the pre-Laya gate in `assessDecomposability` only checked whether the complexity band would let economics delegate at all (`decompositionBoundary`), not this signal, so Laya was asked anyway, answered 0.5943 (just over the 0.3333 threshold for this complexity band), and the run paid for a planning dispatch that produced nothing (0 children spawned, as always — §4.3).

Node `d720ba0b-0bce-47c9-85ea-1beb7308fe7c` (`seaborn-3187` cherryontop rep82) — same pattern, but here the heuristic itself was genuinely ambiguous (`coherent_single_task: 0`, because the goal text tripped `distinct_work_types: 2` and `separate_items: 2`), so asking Laya was defensible in isolation; it just also turned out wrong (Laya said 0.91 decomposable, delegated, self-executed anyway). This run's extra cost is mostly the task's real difficulty (see its `validation.result` evidence: ~20 distinct `pytest`/`python -c` probes to isolate a numeric-legend-formatting edge case in `matplotlib`'s `ScalarFormatter`/`locator_to_legend_entries`), with the wasted planning dispatch a small addition on top.

### 5.2 `requests-1142`'s legacy Python 2.7 environment (root of §6.2's fix)

`requests-1142`'s test suite needs a separate conda environment (`req_py27`). The rep81 outlier's `validation.result` evidence trail (from `~/.org/state.db`) shows five distinct attempts before an accepted observed pass:
```
/home/abhay06102003/anaconda3/bin/python3 -m pytest test_requests.py -k test_no_content_length -v
/home/node/.conda/envs/req_py27/bin/python -c "class Fake(object): ..." # probing prepare_content_length directly
/home/node/.conda/envs/req_py27/bin/python -c "import unittest; loader = ...; suite = TestSuite([...5 names...])"
/home/node/.conda/envs/req_py27/bin/python -c "import unittest; ... loadTestsFromName('RequestsTestCase.test_no_content_length', ...)"
/home/node/.conda/envs/req_py27/bin/python -c "print 'ok'"   # confirming Python-2 syntax still works in this env
```
This is CherryOnTop's single worst per-instance turn gap (24 mean turns vs direct's 10 on the same instance) — plausibly because CherryOnTop's validation gate demands an *observed* passing test (V2 level) before accepting a fix, which forces this discovery every run, whereas the `direct` arm (plain Claude Code, no such gate) apparently settles for less rigorous self-verification and doesn't pay the same tax. Fixed today by caching the successful command per-repository (§6.2) — expected to remove this rediscovery cost on future runs against this repo.

### 5.3 `xarray-6744` direct rep81 — unexplained by design

$0.9385, 30 turns, 1.68× its instance's median (the single largest cost in the whole matrix). The `direct` arm runs plain Claude Code outside the org daemon, so unlike every `cherryontop` run it left **no event trace** in `~/.org/state.db` to root-cause against. This is a visibility gap in the harness, not a finding about the run itself — if direct-arm outliers matter for future investigation, `run_instance.mjs` would need to capture its own transcript (it currently doesn't; confirmed by grep — no log/save call for the direct path).

---

## 6. Bugs found and fixed this session

### 6.1 Laya asks System-1 even when the heuristic already said "coherent"

- **File:** [`src/system1/decomposability.ts`](../../src/system1/decomposability.ts) (`assessDecomposability`)
- **Symptom:** two of the three cost outliers (§5.1) traced to the same pattern — the deterministic heuristic (`assessDecomposition`) already flags `coherent_single_task: 1` for a goal, but `assessDecomposability`'s pre-Laya gate list didn't check that signal, so System-1 got asked anyway, occasionally answered "decomposable" on a noisy probability, and the run paid for a planning dispatch that (per §4.3) never converts to real delegation on this benchmark.
- **Fix:** added a new gate, checked after the existing `economics-would-not-delegate` check (so a low-complexity goal keeps its original gate label and the existing test `does not ask when no answer could make economics delegate` — asserting `gate === 'economics-would-not-delegate'` on `"fix the typo in README.md"` — is unaffected): if `signals.coherent_single_task === 1`, skip System-1 and answer "don't split" directly.
- **Diff:**
  ```diff
       : explicit ? 'explicit-split-request'
       : !boundary ? 'economics-would-not-delegate'
  +    : signals.coherent_single_task === 1 ? 'coherent-single-task'
       : undefined;
  ```
- **Scope of the fix:** only the case where the heuristic is *confident* (`coherent_single_task === 1`, i.e. single work-type verb, no conjunctions/list items, no explicit split request) is gated. An ambiguous goal (multiple work types or conjunctions present, like the seaborn case in §5.1) still asks Laya as before — this fix removes the clear-cut waste, not Laya's role in genuinely ambiguous cases.
- **Not yet fixed / open:** the ambiguous-heuristic case (seaborn-style false positive) is unchanged — Laya can still misjudge a goal the heuristic itself is unsure about. A next step would be recalibrating Laya specifically for bug-fix-report-shaped text (SWE-bench issues commonly contain reproduction-step lists and multiple incidental work-type words like "fix" + "test", which trip `CONJUNCTION`/`WORK_TYPES` regexes even for genuinely single-file fixes).

### 6.2 Verified test commands were never cached across runs

- **File:** [`src/lifecycle/node-actor-manager.ts`](../../src/lifecycle/node-actor-manager.ts) (`runValidation`, new `rememberVerifiedCommands`)
- **Symptom:** every run against the same repository rediscovers "how do I run this repo's tests" from scratch by trial and error (§5.2). The org runtime already has a working cross-run knowledge store (`knowledge` table, `src/evidence/store.ts`) with both write (`putKnowledge`) and read (`queryKnowledge`, wired into the decision engine via `historicalEvidenceSource` in `src/lifecycle/economic-runtime.ts`) — but nothing had ever written a *verified command* to it. (The store already had one writer, `rememberAnswer`, for a node's final self-reported answer — an unvalidated `observation`, not a checked fact.)
- **Fix:** `runValidation` now calls a new `rememberVerifiedCommands(db, nodeId, evidence.observedChecks, now)` right after a run passes (`gated.passed`). It filters `observedChecks` to the ones that actually passed, and for each writes a `knowledge` row: `kind: 'fact'`, `content: "A command that runs this repository's tests and passed: \`<command>\`"`, keyed by `repository` + `revision` (via the existing `repoIdentity`/`repoHead` helpers, same as `rememberAnswer`), `confidence: 1`, `validated: true` (an observed pass outranks a self-report at the same retrieval overlap, per the store's own ranking rules in `evidence/store.ts`).
- **Why no new retrieval code was needed:** the read side (`historicalEvidenceSource` → `queryKnowledge`) was already registered and already surfaces matching `knowledge` rows as `acquire_evidence` candidates at every execution boundary, scoped by repository+revision. This fix is purely the missing write side — the existing "reading beats re-deriving" infrastructure now actually gets fed this class of fact.
- **Diff:**
  ```diff
  + function rememberVerifiedCommands(db, nodeId, observedChecks, at) {
  +   const passing = observedChecks.filter((check) => check.passed);
  +   if (passing.length === 0) return;
  +   try {
  +     ... repoIdentity/repoHead, same guard as rememberAnswer ...
  +     for (const check of passing) {
  +       putKnowledge(db, { kind: 'fact', content: `A command that runs this repository's tests and passed: \`${check.command}\``,
  +         repository, revision, confidence: 1, validated: true, createdAt: at });
  +     }
  +   } catch (err) { console.error(...) }
  + }
    ...
  + const evidence = validationEvidenceFor(db, nodeId, succeeded);   // was inlined; now bound so it can be reused below
    const result = validate({ evidence, contract: contractForProfile(profile) });
    ...
    publish({ id, nodeId, type: 'validation.result', payload, createdAt: now });
  + if (gated.passed) rememberVerifiedCommands(db, nodeId, evidence.observedChecks, now);
  ```
- **Not yet verified:** this fix has **not been exercised by a rerun** — its effect (fewer discovery turns on a second run against the same repo/revision) is a prediction from reading the existing retrieval wiring, not a measured result. The next matrix run against these same 6 instances is the natural verification (watch `requests-1142`'s mean turns specifically).

### 6.3 Operational: host CLI auto-update broke the runner-image version-parity guard mid-run

- **Files:** [`Dockerfile`](../../Dockerfile) (line 23), `scripts/build-runner-image.sh` (unchanged, just re-run)
- **Symptom:** at 05:37 UTC, `pydata__xarray-6744` direct rep81 failed on attempt 1 with:
  ```
  Error: claude CLI differs between arms: host "2.1.283 (Claude Code)", runner image pin "2.1.280".
  Rebuild the image (scripts/build-runner-image.sh) with the host's version.
  ```
  The host's `claude` CLI had auto-updated from 2.1.280 to 2.1.283 partway through the benchmark (this is expected/by-design behavior of the version-parity guard in `bench/swebench/run_instance.mjs` — it refuses to run rather than silently compare two different CLI versions across arms — but nothing in the harness pins or freezes the host CLI version during a benchmark session, so an unattended run can stall indefinitely on this).
- **Fix applied:** bumped the pinned version in `Dockerfile` from `2.1.280` to `2.1.283` and re-ran `sg docker -c "bash scripts/build-runner-image.sh"` (full rebuild, not the cached layer — confirmed by `npm install -g @anthropic-ai/claude-code@2.1.283` actually executing rather than showing `CACHED`). The driver's own retry loop (`runCell`, up to 3 attempts with a 60s sleep) picked the cell back up automatically once the image was ready; no data was lost, no manual re-launch needed.
- **Cost:** ~4 minutes stall, 1 automatic retry attempt.
- **Open/unfixed:** nothing prevents this from recurring on a future overnight/unattended run. A durable fix would freeze the host CLI version for the duration of a benchmark session (e.g. `npm config set` a pin, or disabling the CLI's self-update check via an env var if one exists) rather than relying on someone noticing and rebuilding.

### 6.4 (Tooling, not code) Monitor re-arm replayed history and produced duplicate chat updates

- Not a codebase bug — a session-tooling mistake made while babysitting the run. The first `Monitor` watch used `tail -F -n +1` (full-file-from-start, then follow); re-arming it after a 30-minute expiry with the same command replayed all 12 already-reported lines as "new" events. Caught immediately, fixed by re-arming subsequent watches with `tail -F -n 0` (follow-only, no history replay) and stopping the stale duplicate watcher (`TaskStop`). No benchmark data was affected; only chat reporting had transient duplicates for one cycle.

---

## 7. All changes made this session (files touched)

| File | Change | Committed? |
|---|---|---|
| `src/system1/decomposability.ts` | Fix 6.1 — new `coherent-single-task` gate | Yes, `0a6f7cc` |
| `src/lifecycle/node-actor-manager.ts` | Fix 6.2 — `rememberVerifiedCommands` + call site | Yes, `0a6f7cc` |
| `Dockerfile` | Fix 6.3 — CLI version bump 2.1.280→2.1.283 | **No** — left uncommitted, scope was "these two small fixes" |
| `bench/swebench/report/build.py` | Added `MATRIX_NAME` env var support (was hardcoded to read `results/matrix-analysis.json`; now reads `results/<MATRIX_NAME>-analysis.json`) so the same script builds a report for any named matrix run | No — uncommitted |
| `bench/swebench/report/findings.json` | Rewritten with this run's findings (2-arm scope, baseline comparison, outlier root causes) | No — uncommitted |
| `bench/swebench/report/matrix-report.html` | Rebuilt via `build.py` from `final-analysis.json` + the new `findings.json`; published as the artifact linked at the top of this report | No — uncommitted |
| `bench/swebench/results/final.jsonl`, `final-analysis.json`, `final.log`, `final.stdout` | Generated by the matrix run itself | No — data, not source |
| `docs/superpowers/2026-09-26-swebench-matrix-report.md` | This report | No — uncommitted (per no-unsolicited-commit policy; ask if you want it committed) |

Only `src/system1/decomposability.ts` and `src/lifecycle/node-actor-manager.ts` were committed and pushed (commit `0a6f7cc`, branch `feat/system1-laya-decision-architecture`), per the explicit request to fix and push "these two small fixes" and nothing else. **Tests and the build were not run before that push**, per explicit instruction — the diff was read and reasoned through by hand (including checking it wouldn't break the existing `decomposability.test.ts` assertions), but this is not a substitute for actually running the suite.

---

## 8. What to verify next (open items)

1. **Run the test suite** (`npm test`) and build (`npm run build`) against commit `0a6f7cc` — skipped this session per explicit instruction, not yet done by anyone.
2. **Rerun the matrix** (or at least `requests-1142` and `seaborn-3187`, cherryontop arm) to measure whether §6.1 and §6.2 actually reduce turns on those two instances as predicted. Neither fix's effect has been measured yet.
3. **The ambiguous-heuristic Laya false positive** (seaborn, §5.1) is still open — only the confident-heuristic case was gated in §6.1.
4. **`xarray-6744` direct rep81's outlier cause** (§5.3) is still unknown — would need transcript capture added to the `direct` arm of `run_instance.mjs` to investigate a recurrence.
5. **Host CLI version pinning** (§6.3) — no durable fix applied, only the immediate unblock (image rebuild). Worth deciding whether to freeze the host CLI for benchmark sessions.
6. **`requests-1142`'s DELEGATE-then-skip-planning path** (§4.3, second trace) — the mechanism that let it skip the planning dispatch entirely (unlike seaborn, which paid for one) wasn't fully traced this session; worth understanding if it recurs.
