# Why Claude Code was cheaper than CherryOnTop: root cause

Date: 2026-09-25. Data: the graded 6 × 3 × 3 SWE-bench matrix (`bench/swebench/results/matrix.jsonl`),
every model call of all 54 runs (CherryOnTop from the daemon's event log, Claude Code from its own session
transcripts, matched 18/18), and a verification rerun after the fixes (`results/verify-fix.jsonl`).

## The answer in one paragraph

CherryOnTop's efficiency architecture works: each CherryOnTop model call carries ~29% less context than
Claude Code's (41k vs 57k tokens), and on the three tasks where both harnesses took the same path (flask,
sympy, xarray) CherryOnTop was 20–25% cheaper. It lost overall because cost is decided by **how many
calls the agent makes**, and three things outside that architecture multiplied calls on the other three
tasks: a validation loop that re-ran finished fixes (requests), a sandbox that could not build a 2019-era
compiled project (scikit-learn), and ordinary run-to-run exploration variance (seaborn). All the extra
money (+$0.058/run) is accounted for by those three instances.

## Where the money went (Laya arm vs Claude Code, mean per run)

| Instance | Claude Code | CherryOnTop | Difference | Cause |
|---|---|---|---|---|
| flask | $0.31, 15 calls | $0.24, 14 | **−$0.07** | lean prompt wins |
| sympy | $0.23, 10 | $0.17, 9 | **−$0.05** | lean prompt wins |
| xarray | $0.62, 23 | $0.51, 23 | **−$0.11** | lean prompt wins |
| seaborn | $0.80, 34 | $0.68, 36 | −$0.12 | variance; Claude Code once fetched the upstream fix with `gh api` |
| requests | $0.26, 12 | $0.45, 33 | **+$0.20** | validation re-ran the finished fix 2–3 times |
| scikit-learn | $0.56, 25 | $1.06, 52 | **+$0.50** | sandbox could not build the project's environment |

## Root causes

1. **Validation re-ran finished work.** The agent fixed requests but proved it with a `python -c` script.
   Validation recognised "a test" by keywords, so the script counted for nothing (and elsewhere a
   `grep … test_requests.py` counted as a test). The node was sent back for a fresh full run, which
   re-read the codebase from scratch. The guard meant to stop identical retries measured "progress"
   over all attempts combined and counted any successful shell command as progress, so it never fired.
   One correct fix was marked FAILED after four runs.
2. **The sandbox could not build old compiled projects.** scikit-learn 0.22 needs Python 3.7-era numpy
   and cython. The lent Python install was read-only (`conda create` failed), the image had no Python
   headers (a venv build failed), and `apt-get` needs root. The agent spent 15–23 calls improvising.
   Claude Code ran `conda create` straight into the user's own (writable) anaconda.
3. **Output and cache writes follow call count.** Output per call was the same in both harnesses
   (~370 tokens). CherryOnTop's +60% output and +18% cache writes came entirely from making more calls
   and from extra dispatches (each dispatch rewrites the cached prefix).
4. **Laya's one visible action cost a little.** It rates every single-issue bug report 0.58–0.69
   "splittable", so on seaborn it bought a planner call that answered "does not split" ($0.05, 1.6% of
   spend). A refit with 9 real bug reports did not change the held-out decisions, so it was not shipped.

What did *not* cause it: the planner, delegation, Laya's latency, the result/plan caches, patch scope
(2.1–2.4 files and 11–13 lines in every arm), or the size of the final report.

## Fixes (all with tests; suite 193 files / 2183 tests green)

| Fix | Where |
|---|---|
| A command counts as verification only when it *is* a test runner, build/type check or script run (`isVerifyingCommand`), never because it mentions "test" | `execution/observation.ts`, used by `efficiency/progress-signals.ts` and validation |
| A validation failure identical to the previous one is never retried | `recovery/engine.ts` |
| A change rejected only for missing proof is retried as a ≤15-turn "prove it" pass on the same tree, with no repo map | `lifecycle/dispatch-helpers.ts`, `node-actor-manager.ts` |
| Conda gets writable env and package dirs (reusing the lent cache); the image gains `python3-dev`. Measured: the sklearn-era env builds in 13 s in the sandbox | `k8s/sandbox-env.ts`, `Dockerfile` |
| Benchmark fairness: the Claude Code arm runs without the operator's GitHub login; its per-model cost is recorded | `bench/swebench/run_instance.mjs` |

## Open

- Laya's decomposability can't tell single bug reports from multi-part tasks. It needs a model or
  question change, not calibration.
- Claude Code's benchmark arm writes into the host's anaconda (it created `~/anaconda3/envs/sklearn_test`).
- `claude -p` does not refresh the login token until it is close to expiry, so the benchmark driver's
  refresh step does nothing early.

## Verified after the fixes (graded by the SWE-bench harness)

| Task | Claude Code | CherryOnTop before (Laya / off) | CherryOnTop after (Laya / off) | Resolved after |
|---|---|---|---|---|
| requests | $0.26, 12 turns | $0.45 / $0.36, 34 / 26 turns | **$0.13 / $0.18, 10 / 14 turns** | 6/6 |
| scikit-learn | $0.56, 25 turns | $1.06 / $0.66, 52 / 33 turns | **$0.45 / $0.56, 25 / 29 turns** | 6/6 |
| scikit-learn + environment notes | | | $0.53 / $0.44, 26 / 23 turns | 3/3 + 3/3 |

Environment notes halved environment-hunting calls (9.8 → 5.0 per run) and removed failed `git stash`
attempts (2 → 0); the cost change (−3%) is within noise.

Projection (the four unchanged tasks from the matrix plus the two fixed ones, not a fresh full run):
CherryOnTop + Laya ≈ $0.36 per run and CherryOnTop without Laya ≈ $0.44, against Claude Code's $0.46.
A fresh 6 × 3 × 3 run is needed to confirm it.
