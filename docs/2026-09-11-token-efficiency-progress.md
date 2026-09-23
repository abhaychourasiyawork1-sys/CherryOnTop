# Phase 4 Token Efficiency — Agreed Scope & Progress

Derived from `docs/2026-09-11-token-efficiency.md`, narrowed to what CherryOnTop's
orchestrator can actually control. Every model interaction happens inside
`claude --print` in a Kubernetes Job; the orchestrator owns the goal string, the
appended system prompt, the model/turn caps and the tool grant — and nothing
inside the agent's own loop.

**Dropped from the source plan, with reason:**

| Source task | Why not |
|---|---|
| 4 — lazy per-turn context expansion | Turns happen inside the Job. No consumer exists. |
| 6 — pre-model observation reduction | Tool output goes CLI→model directly; we only see a log copy afterwards. |
| 8 — per-call context receipts on the request | Requests are `argv` arrays; there is no metadata channel. |
| 13 — turn-level delta context | Same as 4. |
| 11 — DAG/critical-path scheduler | `plan.ts` requires subgoals be independent; nothing to schedule. Concurrency stays at the existing Job-queue level (`dispatch-limit.ts`). |
| 15 — KV cache / warm sandboxes / learned compression | Deferred infrastructure, not needed to hit the target. |
| 2–3 — full content-addressed context store + broker | Replaced by the minimal `DispatchContext` below; a versioned store persists state nothing reads. |

**Targets:** 30–45% fewer tokens per successful task; 15–30% lower p50 and
20–35% lower p95 wall-clock; ≤2% quality and ≤1pp success-rate regression.

**Verification:** unit tests only (`npm test`). No paid benchmark runs.

## Progress

- [x] **T1 — Efficiency telemetry.** `src/efficiency/metrics.ts`, `ledger.ts`. Per-node token/latency ledger, one terminal record on the bus.
- [x] **T2 — DispatchContext.** `src/context/dispatch-context.ts`. Goal-aware selection over structural candidates, budget as a hard ceiling, receipt of what was kept and dropped.
- [x] **T3 — Goal-aware repo maps.** `repo-map.ts` selects task-relevant structure instead of filling a fixed 6000-token budget for every child.
- [x] **T4 — DispatchContextCache.** Reuse an identical selection across Jobs, keyed by repo HEAD + goal + budget.
- [x] **T5 — Structured child-result envelopes.** `src/intelligence/result-envelope.ts`. Children report structure; synthesis stops eating 12k-char transcripts.
- [x] **T6 — Planning fast path.** The judge itself already existed: `decide-execution.ts` short-circuits to SELF_EXECUTE on `worthSplitting === false` before any spend, so a second one would have been duplication. The two real gaps were closed instead — the planner now receives the same goal-selected context a child does rather than exploring from zero for up to 15 turns, and "this goal does not split" is cached like any other answer instead of buying a fresh sandbox to be told again.
- [x] **T7 — Conditional synthesis.** `src/intelligence/integrate-results.ts`. Return a single complete child or merge deterministically instead of dispatching a synthesis sandbox.
- [x] **T8 — Model routing.** `src/intelligence/model-router.ts`. Complexity/role/budget → tier, feeding the existing per-role model selection.
- [x] **T9 — Objective & experiment evaluation.** `src/efficiency/objective.ts` (one module, not two — summarize, score and gate are one concern). Hard quality/success gates that no weighting can trade away, plus `loadEfficiencyRecords` so a comparison can read real runs.
- [x] **T10 — Rollout modes & docs.** `disabled | shadow | enabled`, README/USAGE.

---

## Phase 5 — the token-efficiency architecture (2026-09-13)

The first paid benchmark (`bench/last-run.json`) measured the efficiency work
making a one-file typo fix **3.0× more expensive** with the same outcome. The
diagnosis was not that too much context was sent — it was that optimizing the
*prompt* while leaving the *execution* unbounded optimizes the wrong quantity.
Cost inside a dispatch grows superlinearly in turns, so a smaller prompt that
sends the agent hunting is a more expensive prompt.

The objective is restated accordingly: **cost per successful task**, not
initial prompt size. Correctness stays a hard constraint outside the
arithmetic, because a weighted score can always be improved by spending
quality.

| Task | What landed | Where |
|---|---|---|
| 1 | Frozen baseline: 7 goals labelled by size/family, an expansion set behind `--families`, metrics per *success*, turns surfaced end to end | `bench/`, `src/db/queries/tokens.ts` |
| 2 | Policy contracts + normalizers; unknown is the middle, never an extreme | `src/efficiency/policy-types.ts`, `task-signals.ts` |
| 3 | Generic task-economics signals; a class emits signals, never names a file | `src/efficiency/task-economics.ts` |
| 4 | Adaptive context/execution policy; a budget is a ceiling and uncertainty raises it | `src/efficiency/policy.ts` |
| 5 | Structural candidates over real import edges, extracted on the read the symbol scan already does | `src/context/candidates.ts`, `src/intelligence/repo-map.ts` |
| 6 | Composable scoring; weights are data and contributions are reported term by term | `src/context/scoring.ts` |
| 7 | Progressive selection: escalate while the increment pays, demote rather than drop, widen on low confidence | `src/context/selector.ts`, `dispatch-context.ts` |
| 8 | Cache stability and fail-upward asserted rather than assumed | `src/context/dispatch-context-cache.test.ts` |
| 9 | Turn cap is the tighter of the configured breaker and the policy; soft target told to the agent | `src/lifecycle/node-actor-manager.ts`, `src/prompts/roles.ts` |
| 10 | Spend guard at the single chokepoint, four states, hard spend first | `src/efficiency/spend-guard.ts` |
| 11 | Exploration/progress/repetition read off the tool stream, no model judge | `src/efficiency/progress-signals.ts` |
| 12–13 | Attribution telemetry and policy versions on every measured dispatch | `src/efficiency/{metrics,ledger,objective}.ts`, `src/db/queries/tokens.ts` |
| 14 | An inventory cached before import extraction is a miss, not a file that imports nothing | `src/db/queries/repo-map-cache.ts` |
| 15 | 37 golden cases across eight task families, asserting properties rather than file lists | `src/context/golden-families.test.ts` |
| 16–17 | `context-planner` benchmark arm; deterministic arm run and recorded; guard scored against adversarial trajectories | `bench/` |

**Rollback.** `ORG_CONTEXT_PLANNER=off` returns the lexical selector.
`ORG_MAX_TURNS_EXECUTE=0` removes the turn cap. `ORG_TASK_SPEND_CAP_USD=0`
(the default) means the deployment adds no ceiling of its own. Every one of
these is an environment variable and a daemon restart.

### Evidence status — read this before quoting a number

| Claim | Status |
|---|---|
| The planner sends less context and reaches files lexical matching cannot see | **Measured**, deterministically — `bench/deterministic-2026-09-13.md` |
| The guard stops the right runs (0 false positives over 8 trajectories) | **Measured** — `bench/economic-trajectories.mjs` |
| Cost per successful task is lower | **Not measured.** Needs a live cluster and paid usage |
| Turns per successful task are lower | **Not measured** |
| The original medium-task regression is fixed | **Not measured** |

Gates A (correctness), D (safety) and E (no architectural drift) are met.
Gates B (economics) and C (task generality across real runs) are **open** and
stay open until `node bench/run.mjs context-planner` has been run on a live
cluster. Smaller initial context is the mechanism this architecture bets on —
not the outcome it is judged by.
