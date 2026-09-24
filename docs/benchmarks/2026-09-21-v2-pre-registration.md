# Pre-registration -- CherryOnTop vs. direct Claude Sonnet 5, v2 six-task study

Committed per `docs/benchmarks/PUBLIC-BENCHMARK-PROMPT-V2.md` §1, before any
paid/subscription dispatch has run. This section is copied verbatim from the
source doc and will not be modified after this commit; any later change to
an endpoint will be logged as exploratory in the final report, not folded in
here.

## 1. Pre-registration table

| | Endpoint | Test | Decision rule |
|---|---|---|---|
| **Primary** | Resolve rate, paired per task | McNemar exact on discordant pairs; Wilson 95% CI per arm | Non-inferiority gate: CherryOnTop must not be meaningfully worse. Report discordant pairs individually -- at n=6 they *are* the result |
| **Secondary A** | Cost (USD) per task, paired | Wilcoxon signed-rank + bootstrap CI on the paired median difference | Compared against the prior noise floor (§7.3) before any claim |
| **Secondary B** | Cost per *resolved* task | Descriptive + bootstrap CI | Descriptive only at this n |
| **Secondary C** | Wall-clock, turns, dispatches, all four token classes | Paired, descriptive | |
| **Mechanism** | Which CherryOnTop mechanisms fired, and how often | Counts | Explanatory only. Never used to support the primary claim |
| **Exploratory** | Failure taxonomy; Tier A vs Tier B contrast | Descriptive | Tiers are never pooled into one headline number |

**Hard gates, decided now:**

1. Cheaper-and-worse is a loss. A cost reduction accompanied by a resolve-rate drop is reported as a loss, whatever the p-value.
2. A mechanism that did not fire earns no credit and must be listed as not-fired.
3. Tier A and Tier B are reported separately. Six tasks from two different benchmarks do not average into one number.

## 2. Task list (frozen, published verbatim)

- Tier A (SWE-bench Verified, seed 2026): [`bench/swebench/instances-v2.json`](../../bench/swebench/instances-v2.json) -- 4 main slots (A1-A4) + 1 smoke slot, excluding all 10 instances used by the 2026-09-21 v1 report.
- Tier B (Terminal-Bench, `harbor-framework/terminal-bench`): [`bench/tier-b/tasks.json`](../../bench/tier-b/tasks.json) -- cargo-flight-dispatch (B1, also serves as the Tier B smoke task) and vba-userform-port (B2).
- Arm order (seed 2027): [`bench/swebench/arm_order-v2.json`](../../bench/swebench/arm_order-v2.json), covering all 6 main tasks.

## 3. Deviations from the source doc, disclosed now (not after seeing results)

1. **Billing model**: the operator runs both arms on a Claude subscription, not metered API billing (confirmed with the user before this run). `total_cost_usd`/`costUsd` fields are still recorded from the CLI's own token-based cost accounting for the paired cost analysis in §7.3/§8, but no real per-token dollar spend is incurred beyond the subscription.
2. **Smoke/main overlap on Tier B**: SWE-bench has abundant supply, so Tier A drew a genuinely separate smoke instance (A0). Terminal-Bench tasks are curated and scarce; B1 (cargo-flight-dispatch) serves as both the Tier B smoke gate (§7.1) and one of the two Tier B main pairs (§7.2) -- its result is folded into the main paired dataset rather than discarded. Disclosed as a resource-driven deviation from strict smoke/main separation, not a statistics change.
3. **Tier B execution architecture**: Harbor's own job orchestration (`harbor run --env docker --agent claude-code`) is used as a calibration reference where convenient, but the paired dispatches themselves run through the same architecture as Tier A -- a materialized worktree under `.bench/worktrees/tier-b/`, the direct arm via `claude --print` on the host, the cherryontop arm via `org run --repo`. Official grading still uses each task's own unmodified `tests/Dockerfile` + `test.sh` (cloned verbatim from the task repo), run in Docker, exactly as Harbor's own verifier step would. See `bench/tier-b/run_instance.mjs` and `bench/tier-b/grade.mjs` docstrings.
4. **Tier B instruction path rewrites**: both Terminal-Bench tasks' `instruction.md` hardcode container-absolute paths (`/app/...`, `/shared/...`, `/workspace/...`) that only exist inside Harbor's own orchestrated container. Both arms receive an identically rewritten instruction (absolute prefixes replaced with worktree-relative paths; for cargo-flight-dispatch, one environment note about `dispatch.py --data-dir` explaining the same path difference) -- applied symmetrically, disclosed verbatim in the report, not a hint about the underlying bugs being tested.
5. **Tier B baseline dataset-version note**: the published Sonnet 5 baseline (80.4%, Claude Sonnet 5 System Card §8.3, 2026-06-30) is measured on "Terminal-Bench 2.1" (89 tasks, mini-SWE-agent harness). The task repository available at pre-registration time (no version tag; `dataset.toml` header reads `terminal-bench-3`) is a later dataset generation. Same benchmark identity (arXiv:2601.11868), not a guaranteed-identical task pool -- see `bench/tier-b/tasks.json`.

## 4. Preflight, completed before this commit

- `npm run typecheck` / `npm run build` / `npm test`: pass (170 files, 2013 tests).
- `node bench/capability-regimes.mjs`: 10/10 regimes reachable.
- `node bench/strategy-regimes.mjs`: 8/8 strategy regimes reachable.
- `docker`, `kind` cluster (`org-local-control-plane`), `claude` CLI (v2.1.263, authenticated), `org` CLI: all confirmed present and working.
- `bench/swebench/run_instance.mjs` `PINNED_MODEL` corrected from the `'sonnet'` alias to the exact id `'claude-sonnet-5'` (§3.1).
- Tier B grading pipeline validated pre-registration, with zero model calls, against each task's own oracle solution: `cargo-flight-dispatch` oracle -> reward 1/1 (27/27 tests pass); `vba-userform-port` oracle validation in progress at commit time, result to be reported in §4 (Validity) of the final report, not used to tune anything.
