# Why CherryOnTop cost more than Claude Code on SWE-bench: root-cause report

Date: 2026-09-25. Branch `feat/system1-laya-decision-architecture` at `d2117c3` (PR #3).
Scope: the harness-compare benchmark (6 SWE-bench Verified instances × 2 valid reps × 2 arms,
Sonnet 5 on both arms). Every number below comes from the files listed in §9.

## 1. Headline

| Metric (mean per run) | Claude Code alone | CherryOnTop | Delta |
|---|---|---|---|
| Cost | $0.400 | $0.530 | **+32%** |
| Tokens incl. cache writes | 949k | 1.449M | **+53%** |
| Turns | 16.4 | 31.2 | **+90%** |
| Tokens per turn | ~58k | ~46k | CherryOnTop 20% *cheaper* |
| Self-reported complete | 12/12 | 7/12 | |
| Cost per success | $0.400 | $0.445 | +11% |

| Instance | Claude Code $ / turns | CherryOnTop $ / turns | CherryOnTop outcome |
|---|---|---|---|
| flask-5014 | 0.21 / 11.5 | 0.34 / 26.5 | 2 × complete |
| requests-1142 | 0.31 / 16 | 0.67 / 38.5 | 2 × complete (rep 1: 59 turns, web search) |
| seaborn-3187 | 0.64 / 16 | 1.11 / 61 | 2 × FAILED at the 60-turn cap |
| sklearn-14710 | 0.52 / 23.5 | 0.51 / 30.5 | 1 complete, 1 FAILED at the 34-turn cap |
| sympy-17139 | 0.21 / 10 | 0.29 / 23 | 2 × complete |
| xarray-6744 | 0.51 / 21.5 | 0.25 / 8 | 2 × FAILED (read-only, no edit) |

**The whole excess is turn count.** Each CherryOnTop turn is cheaper. It takes about twice as many.
Every run was a single execute dispatch: no split and no children. Orchestration overhead
(planner, Laya, validation) is under 1% of spend.

## 2. Did Laya cause this? No. Laya was not running.

- The daemon log for the benchmark window reads `System-1 unavailable (could not start
  laya-serve: spawn laya-serve ENOENT)`. `laya-serve` lived in an ephemeral scratchpad venv
  that is not on the daemon's `PATH`.
- All 10 `system1.judgment` events in the benchmark have the reason `laya is unreachable:
  fetch failed`. Every decision came from the deterministic fallbacks.
- So this benchmark measured **CherryOnTop without Laya**. The label "CherryOnTop + Laya" on
  these rows is wrong.

Even with Laya running, it would not have moved these numbers:

- Laya answers orchestration questions only: split or not (`execution.decomposable@2`),
  whether a boundary helps, and optional `<cto_decide>` frames. Each costs ~300 prompt tokens
  and 20–70 ms, with no model tokens.
- About 100% of the spend is inside one execute dispatch, the Claude turn loop. Laya never sees
  that loop and has no say in how many turns it takes, how the tests run, or what tools exist.
- For single-issue bug fixes the economics gate skips the split question anyway (as it did
  for flight-dispatch in Tier-B).

**The expectation "Laya should reduce cost" does not hold for this workload.** Laya can save
money only where CherryOnTop would otherwise make a costly orchestration mistake, such as a
needless split or a wrong fan-out. SWE-bench single-issue fixes have none. The costs below
come from the execution environment, the prompt and policy, not from System-1.

There is one place where Laya *should* be deciding and is not. See root cause 5 (xarray).

## 3. Where the extra turns go

Tool calls per run, classified from both arms' transcripts (xarray excluded because it had
no edit tools; `/tmp/claude-1000/an/classify.py`):

| Category | Extra calls per run (CherryOnTop minus Claude Code) |
|---|---|
| explore (Read/Grep/Glob/ls/cat) | **+7.4** |
| run / test | **+5.0** |
| wait / poll (background tasks) | +1.8 (seaborn alone: 17) |
| other (ToolSearch, TaskStop, WebSearch…) | +1.3 |
| environment setup (pip, python discovery) | +1.1 |
| edit | +0.6 |
| **total** | **34.8 vs 17.4 = +17.4** |

Edits are nearly equal: both arms make the same fix. CherryOnTop spends its extra turns
**finding its footing in the sandbox and proving the fix**.

## 4. Root causes, ranked by cost impact

### RC1: The sandbox has no project environment (largest single cause)

- The runner image has a bare `python3` + pip and none of the repository's dependencies. Every
  Job starts fresh, so installs are lost between attempts.
- Claude Code alone runs on the host, where the SWE-bench repos already have their
  dependencies installed.
- Evidence (flask): CherryOnTop spent **11 extra calls** fighting pytest/werkzeug versions
  before a test would run. Claude Code ran `pytest` once. The same pattern shows up on
  sklearn and seaborn (missing compiled extensions and pinned versions).
- Why it is expensive: every extra call re-reads the whole cached context (~46k tokens per
  turn).

### RC2: Background-task friction in headless Claude Code

- Long `pytest` runs are auto-backgrounded by the CLI. In `--print` mode the agent then
  loops: `sleep` is blocked, then `ScheduleWakeup`, `ToolSearch`, `TaskStop`, polling output
  files, and `ps` is missing from the image.
- Evidence (seaborn): **17 wait/poll calls in turns 35–61**, which is what pushed both reps
  over the cap.
- Claude Code alone on the host hit this far less, because tests run faster with deps
  present, and it has a newer CLI (see RC9).

### RC3: git is broken inside the sandbox

- The benchmark gives each run a `git worktree`. The worktree's `.git` is a *file* that points
  to the main repo's `.git/worktrees/...` on the host, and that path is not mounted in the pod.
- Evidence: **2–7 "not a git repository" errors per run**, followed by extra exploration to
  find the original code (`git diff`, `git stash` and `git log` all fail).

### RC4: Lower turn caps, and a cap hit counts as failure even with a verified fix

- Claude Code alone had `--max-turns 80`. CherryOnTop's execute cap is
  `min(ORG_MAX_TURNS_EXECUTE (default 60), complexity band)`, which gave flask 35, sklearn 34 and
  seaborn 60.
- Seaborn (61/60 turns, both reps) and sklearn rep 3 (35/34) **had the fix in place with V2
  observed verification passing** when they were cut off.
- `error_max_turns` → no success claim → validation ladder V0 fails → **FAILED**. The retry
  is refused instantly by the turn-cap guard, so the correct patch is thrown away as a
  failure.
- That accounts for 3 of the 5 CherryOnTop failures, and they are *accounting* failures, not
  wrong fixes.

### RC5: xarray misclassified as "investigative", so the agent had no edit tools (a Laya-shaped bug)

- `src/lifecycle/decompose.ts` marks a goal investigative when the regex `INVESTIGATIVE`
  matches words such as *why, understand, trace, debug, review, audit, root cause*.
- The xarray issue text contains "why". `investigativeExecuteGrant`
  (`src/lifecycle/dispatch-helpers.ts`, called at `node-actor-manager.ts` ~1880) then narrows
  the grant to **Read/Grep/Glob/LS**.
- The agent found and explained the correct fix, then said it could not apply it. Result: 8
  turns, $0.25, FAILED, twice.
- One keyword decides a very important question: *is this a change request or an explanation
  request?* The regex cannot tell "why does X crash, please fix" from "explain why X".

### RC6: The result cache stores and replays failed answers

- `node-actor-manager.ts` (~2115–2145) calls `putCachedResult` when `result.succeeded`, which
  means the **Job** succeeded, not validation.
- The read-only xarray answer (which failed validation) was cached. The retry and the later
  reps with the same reuse key got the same useless answer for $0. xarray CherryOnTop reps
  2–5 are invalid and excluded by `VALID_REPS`.

### RC7: The execute prompt pushes extra verification

- `src/prompts/roles.ts` → HARNESS_CONSTITUTION: "Produce evidence… what you ran, what you
  verified", plus the envelope instructions. `definition_of_done` is the whole issue text
  (`src/cli/commands/run.ts:75`).
- Evidence: run/test calls on flask were **6–15 for CherryOnTop vs 1 for Claude Code**.
- The instruction is deliberate: the V2 "observed verification" rung needs it. The cost comes
  from combining it with RC1 and RC2, where each verification attempt costs several turns.

### RC8: Measurement bugs (these distort the comparison, not the spend)

| Bug | Where | Effect |
|---|---|---|
| `tokensByRole` omits `cacheCreationTokens` | `src/db/queries/tokens.ts` | `org tokens` under-reports CherryOnTop tokens (analysis JSON 1.417M vs true 1.449M) |
| Patch file appended, not written | `bench/swebench/run_instance.mjs` (`appendFileSync`) | 8/24 patch files had an older run's patch glued in front (all 24 recovered to `/tmp/claude-1000/an/patches/`, sizes verified) |
| Reps reused across runs | same runner | Result cache and file collisions, so `VALID_REPS` had to be hand-picked |
| "Success" is self-reported on both arms | runner | Neither arm is graded yet (see §7) |
| Benchmark ran without Laya, silently | daemon startup | A whole comparison labelled "+ Laya" measured no Laya |

### RC9: Confounders

- Claude CLI **2.1.261 in the runner image vs 2.1.280 on the host**. Background-task handling
  differs between versions (RC2).
- requests rep 1 is a single outlier: 59 turns, including 27 explore calls plus WebSearch and
  WebFetch.
- n = 2 reps per instance. Differences under ~20% on a single instance are noise.

## 5. Questions asked, answered

| Question | Answer |
|---|---|
| Is Laya expensive? | No. Zero cost in this run (it was down). When up: ~300 prompt tokens per question, no model tokens. |
| Does the Laya implementation introduce the extra turns? | No. The turn loop is untouched by System-1. The costs are sandbox environment, git, turn caps, prompt, and a regex grant. |
| Is orchestration (planner, validation, retries) the overhead? | No. Under 1% of spend; there was one dispatch per run. |
| Is each CherryOnTop turn more expensive? | No, 20% cheaper (a smaller prompt and cache). There are just twice as many turns. |
| Were CherryOnTop's failures wrong fixes? | 3/5 were correct fixes cut off by the cap, and 2/5 (xarray) were blocked from editing. None was shown to be a wrong fix. |
| Is the comparison fair? | No. It differs on environment, turn cap, CLI version and git, and Laya was off. |
| Would equal conditions close the gap? | Probably most of it. RC1–RC4 explain roughly 12–15 of the 17 extra calls per run. That is an estimate and needs a rerun to confirm. |

## 6. Fixes

Ordered by expected saving per unit of work. "Laya" marks where System-1 should take over.

| # | Fix | Addresses | Where |
|---|---|---|---|
| F1 | Per-repo prepared environment: build the env once (image layer or a cached `site-packages` volume keyed by repo + commit), or mount the host venv read-only for benchmarks | RC1 | runner image / Job spec |
| F2 | Pass `--disallowedTools ScheduleWakeup,CronCreate,Monitor,RemoteTrigger,…` to headless runs, and raise `BASH_DEFAULT_TIMEOUT_MS`/`BASH_MAX_TIMEOUT_MS` so tests run in the foreground; add `procps` to the image | RC2 | execute adapter, Dockerfile |
| F3 | Make git work in the sandbox: mount the main repo's `.git` at the same path, or use real clones instead of worktrees in the benchmark | RC3 | `materializeGoalWorktree`, Job mounts |
| F4 | On `error_max_turns` with V2 evidence present, give **one wrap-up turn** through session stdin ("state what you changed and verified") instead of failing. Do not count it against the retry guard | RC4 | execute-step / validation |
| F5 | Benchmark with equal caps: `ORG_MAX_TURNS_EXECUTE=80` for CherryOnTop, since Claude Code gets `--max-turns 80` | RC4 | `bench/swebench/run_instance.mjs` |
| F6 (**Laya**) | Replace the `INVESTIGATIVE` regex with a System-1 question such as `execution.change_requested@1` ("does the goal ask for a change to the code, or only an explanation?"), with the regex as the fallback only when Laya is down. A read-only grant needs a confident "explanation only" | RC5 | `decompose.ts`, `dispatch-helpers.ts`, calibration set |
| F7 | Cache results only after validation passes, and never serve cache on a retry caused by a validation failure | RC6 | `node-actor-manager.ts` ~2115–2145 |
| F8 | Add `cacheCreationTokens` to `tokensByRole` | RC8 | `src/db/queries/tokens.ts` |
| F9 | Runner: `writeFileSync` for patches, unique rep numbers per run, `--no-cache` for benchmark runs | RC8 | `run_instance.mjs` |
| F10 | Preflight: `org doctor` and the benchmark runner **refuse to start** when `ORG_SYSTEM1` is on and Laya is not ready; record `system1.available` on every row | RC8 | daemon startup, runner |
| F11 | Pin the same claude CLI version in both arms | RC9 | Dockerfile / runner |
| F12 | Keep the verification demand (V2 needs it), but make it cheap: say "run the narrowest relevant test once" in the execute prompt | RC7 | `roles.ts` |

F1–F5 are fairness and infrastructure fixes, and they should come before any claim about
Laya. F6 is the one change that gives Laya real work on this workload. F7–F11 make the
next measurement trustworthy.

## 7. Grading status (not done)

Official SWE-bench grading of the 24 recovered patches was attempted and **failed with exit
1 because the disk filled up** (SWE-bench eval images are 4–7 GB each). The five pulled
images were removed to free space, and grading was skipped by decision. So resolution rates
are unknown for both arms, and "complete" means self-reported only.

Reproduce (needs ~35 GB free):

```bash
cd /tmp/claude-1000/an
for n in hc-direct-A hc-cherryontop-A hc-direct-B hc-cherryontop-B; do
  sg docker -c "/home/abhay06102003/Desktop/CherryOnTop/.swebench/bin/python -m swebench.harness.run_evaluation \
    --dataset_name SWE-bench/SWE-bench_Verified --predictions_path preds/$n.jsonl \
    --run_id $n --max_workers 2 --timeout 1800 --cache_level none"
done
```

## 8. Recommended rerun

1. Apply F1, F2, F3, F5, F7, F9, F10 and F11 (fairness plus measurement).
2. Start `laya-serve` on the daemon's `PATH` and confirm `org doctor` shows System-1 ready.
3. Run 6 instances × 3 reps × 3 arms: Claude Code, CherryOnTop with `ORG_SYSTEM1=off`,
   CherryOnTop with Laya. The Laya-vs-off pair isolates what Laya does. The off-vs-Claude pair
   isolates the harness.
4. Grade with SWE-bench and compare **cost per resolved instance**, not self-reported
   success.
5. Then apply F4, F6 and F12 and rerun to measure each one.

## 9. Data and tooling

| What | Where |
|---|---|
| Raw rows | `bench/swebench/results/harness-compare-{direct,cherryontop}.jsonl` |
| Aggregates | `bench/swebench/results/harness-compare-analysis.json` (tokens exclude cache writes) |
| Analysis script and valid reps | `bench/swebench/analyze_harness_compare.py` (`VALID_REPS`) |
| Patches (runner output; 8 corrupted) | `bench/swebench/patches/<instance>.<arm>.<rep>.patch` |
| Recovered clean patches (24) | `/tmp/claude-1000/an/patches/` |
| SWE-bench predictions | `/tmp/claude-1000/an/preds/hc-{direct,cherryontop}-{A,B}.jsonl` |
| Tool-call classifier and output | `/tmp/claude-1000/an/classify.py`, `/tmp/claude-1000/an/rows.json` |
| Per-tree event trace | `/tmp/claude-1000/trace.sh <node-prefix>` |
| Claude Code transcripts | `~/.claude/projects/*swebench-repos-<repo>--bench-worktrees-*/*.jsonl` |
| Daemon log (Laya ENOENT) | pm2 logs for the org daemon |

`/tmp` paths are ephemeral. Copy them into `bench/swebench/` before relying on them.

## 10. Fix status (2026-09-25, same day)

All fixes below are in the working tree on `feat/system1-laya-decision-architecture`. The unit
suite passes (192 files, 2178 tests), and each fix has a regression test.

| Fix | What changed | Where |
|---|---|---|
| F1 | Host toolchain lent read-only (`ORG_SANDBOX_TOOLCHAIN`; the runner lends the host `python3`'s prefix). It reaches the agent's Bash tool through `CLAUDE_ENV_FILE`, because Claude Code ignores the container `PATH` (measured). The image also gains `build-essential` | `src/k8s/sandbox-env.ts`, `Dockerfile` |
| F2 | `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, cron off, 10/30-minute Bash timeouts, `--disallowedTools` for wait/poll tools, `procps` | `sandbox-env.ts`, `adapters/claude-code.ts`, `Dockerfile` |
| F3 | The repository's `.git` is mounted read-only at its host path, and the worktree's admin directory is writable. A live pod runs `git log`/`git diff`, and a ref write is refused | `sandbox-env.ts`, `k8s/job-manifest.ts` |
| F4 | A run cut off at the cap after an edit whose last test passed (not piped, no failure output) is handed to validation as a claim. It costs no extra turn | `execution/observation.ts`, `node-actor-manager.ts` |
| F5 | The runner sets `ORG_MAX_TURNS_EXECUTE=80`. It also restarts the daemon when its `ORG_*` settings or build differ, because a running daemon never saw them (new bug) | `bench/swebench/run_instance.mjs`, `daemon.ping.envDigest` |
| F6 | The Laya question `execution.change_requested@1`. The rule decides when the words settle it ("fix", "expected", "do not modify"), and Laya decides the rest (read-only needs P(explain) ≥ 0.7). The same rule also stopped letting "review"/"why" anywhere mark a task read-only for validation | `system1/change-request.ts`, `intelligence/decompose.ts`, `efficiency/task-economics.ts` |
| F7 | An answer is cached only after validation passes, and never served on a retry after a failed validation | `node-actor-manager.ts` |
| F8 | `cacheCreationTokens` is added to `tokensByRole` and `org tokens` | `db/queries/tokens.ts`, `cli/commands/tokens.ts` |
| F9 | Patches are written instead of appended, a recorded rep is refused, and caches are off | runner |
| F10 | The runner refuses to run until the daemon's System-1 is ready, unless `ORG_SYSTEM1=off`. `org doctor` asks the running daemon. Laya lives at `~/.org/laya` (auto-discovered). Every row records `system1Available` | runner, `cli/commands/doctor.ts`, `config/system1.ts` |
| F11 | The image is pinned to CLI 2.1.280, and the runner refuses to run if the host version differs | `Dockerfile`, runner |
| F12 | The execute prompt says to verify with the narrowest check, and a definition-of-done item equal to the goal is no longer repeated in the system prompt | `prompts/roles.ts`, `node-actor-manager.ts` |

Found while fixing: the runner priced Sonnet 5 at Sonnet 4 rates (it killed the direct arm at two
thirds of its budget); an expired login recorded $0 "FAILED" rows (the runner now checks first); and
test stubs had only passed because they relied on RC6's replay.

Live rerun (CherryOnTop with Laya ready, $3 cap, n=1 each, self-reported, not graded; the patches
match the upstream fixes on inspection):

| Instance | Claude Code | CherryOnTop before | CherryOnTop after |
|---|---|---|---|
| flask-5014 | $0.21 / 11.5 turns | $0.34 / 26.5 | **$0.14 / 12**, complete |
| xarray-6744 | $0.51 / 21.5 | $0.25 / 8, FAILED ×2 | **$0.32 / 22**, complete |
| seaborn-3187 | $0.64 / 16 | $1.11 / 61, FAILED ×2 | **$0.51 / 25**, complete (before the toolchain PATH fix) |

Open: with Laya live, seaborn's issue scored P(decomposable)=0.91 and paid a $0.05 haiku planner
that answered "does not split". Refit the decomposability calibrator with SWE-bench issues in the
labelled set. Still to do: the full 6×3×3 rerun and SWE-bench grading (§8).
