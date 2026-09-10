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
- [ ] **T6 — Planning fast path.** Judge trivial/simple goals into direct execution before paying for a planning sandbox.
- [x] **T7 — Conditional synthesis.** `src/intelligence/integrate-results.ts`. Return a single complete child or merge deterministically instead of dispatching a synthesis sandbox.
- [ ] **T8 — Model routing.** `src/intelligence/model-router.ts`. Complexity/role/budget → tier, feeding the existing per-role model selection.
- [ ] **T9 — Objective & experiment evaluation.** `src/efficiency/objective.ts`, `experiment.ts`. Scoring and hard quality/success gates as pure functions.
- [ ] **T10 — Rollout modes & docs.** `disabled | shadow | enabled`, README/USAGE.
