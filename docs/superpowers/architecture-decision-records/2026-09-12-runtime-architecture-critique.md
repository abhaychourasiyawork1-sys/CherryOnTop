# Architecture critique: the context/execution runtime plan against the actual runtime

**Status:** accepted — reform. **Date:** 2026-09-12. **Branch:** `feat/token-efficiency`.
**Subject:** `2026-09-12-cherryontop-context-execution-runtime-implementation-plan.md` (34 tasks, Parts I–XV).

## Summary

The plan's objective is right and its doctrine — avoid → reuse → retrieve → select →
materialize → execute → escalate → compress — is the correct order of operations. Its
*architecture* is written for a runtime CherryOnTop is not. Roughly half the tasks
optimize a term that, in this system, is ~0.3% of spend, and the one term that is ~97%
of spend is not addressed by any task in the plan.

The reform gate is cleared on repository evidence. The six primitives survive in
intent; three of them are already implemented under different names, and three cannot
be implemented here at all without changing what CherryOnTop *is*.

## Finding 1 — CherryOnTop does not own a model context window

This is the load-bearing fact and it invalidates the largest part of the plan.

A dispatch is a whole agent CLI running inside a Kubernetes Job
([execute-step.ts:132](../../../src/execution/execute-step.ts#L132)):

```
adapter.buildCommand(goal, grant, { model, maxTurns, systemPrompt })
  → buildExecutionJob(...) → createJob → followJobLogs(consume) → StructuredEvent[]
```

The agent's tools run *inside* that Job. Their output goes straight into the agent's own
context window. CherryOnTop sees it only afterwards, as JSONL lines it appends to the
event log and publishes on the bus ([node-actor-manager.ts:855](../../../src/lifecycle/node-actor-manager.ts#L855)).
Nothing CherryOnTop does to those events can make the model read fewer of them — the
model already read them, in-sandbox, before the line was printed.

CherryOnTop controls exactly four things:

| Lever | Where |
|---|---|
| whether a dispatch happens at all | `decideExecution`, `decideIntegration`, plan cache, the queued-cancel guard |
| how many dispatches happen | `maxChildJobs`, `parseSubgoals`, fan-out authority |
| what the argv carries | `goal` + selected repo context + `--append-system-prompt` |
| when a dispatch stops | `maxTurns`, `timeoutMs`, `cancelSubtree` |

**Consequence.** Plan Part VI (Tasks 10–12: canonical `Observation`, tool-projection
registry, evidence planner) reduces the size of *our event log*. The event log costs
zero model tokens. These tasks cannot move the objective. Likewise Task 4's
`expand`/`diff`/`subscribe` Context RPC, Task 6's progressive materialization, and
Task 8's delta projections: they all presume we assemble each model turn. We assemble
one argv, once, per dispatch.

## Finding 2 — the objective is dominated by turns, not by context

From the one fully-recorded production run ([docs/token-efficiency-diagnosis.md](../../token-efficiency-diagnosis.md),
node `5432bd11`, authoritative `modelUsage` aggregates):

| term | measured |
|---|---|
| `input_tokens` per Job (the argv — goal + repo context + prompts) | **22–46** |
| `cache_read_input_tokens` per Job | **651,955 / 1,136,108 / 1,772,218** |
| total across 6 dispatched Jobs | ~4.2M read, ~119 turns, $2.65 |

The whole `ORG_REPO_MAP_TOKENS=6000` handoff is an upper bound of 6k tokens per
dispatch against ~1.7M actually spent by that dispatch. Goal-aware context selection —
the plan's Parts III–V, nine tasks — operates on **under 0.4%** of the bill.

What the bill actually is:

```
task tokens  ≈  Σ_dispatches Σ_turns prefix(turn),   prefix growing ≈1.26×/turn
```

Two integer terms. Dispatch count has been attacked (five of the six changes in the
diagnosis). **Turns per dispatch is unbounded for `execute`** —
`dispatchOptionsFor('execute')` returns `{}`, so no `--max-turns` reaches the runtime
([efficiency.ts:47](../../../src/config/efficiency.ts#L47)) — and no task in the 34-task
plan touches it. The diagnosis names it as the top remaining bottleneck and the plan
does not contain it.

## Finding 3 — three of the six primitives already exist

| Plan primitive | Already implemented as | Verdict |
|---|---|---|
| Evidence Runtime (Task 1) | `src/efficiency/{metrics,ledger,objective}.ts`, threaded through `recordUsage` | **done** — extend, do not rebuild |
| Projection Runtime (Tasks 5, 7, 9) | `selectDispatchContext` + `DispatchReceipt` + `context.receipt` events + HEAD-keyed inventory cache | **done** — deterministic scoring, hard floor, fail-open-upward, provenance |
| Decision Engine (Task 17) | `assessDecomposition` → `decideExecution`/`scoreDelegation` → `decision.made` + `decisions` table, plus `routeModel`, `decideIntegration` | **done in substance** — a `src/decision/engine.ts` wrapper over these would be a fourth name for the same arithmetic |
| Execution Graph (Task 16) | `nodes` table + xstate `nodeMachine` + `events` chain | **done** — replayable, dependency-ordered, event-sourced |
| Context Objects / Graph / RPC (Tasks 2–4, 8) | — | **rejected**, see Finding 1 |
| Observation Runtime (Tasks 10–12) | — | **rejected**, see Finding 1 |

Building `src/decision/engine.ts`, `src/context/graph.ts`, `src/execution/graph.ts` on
top of these would answer Review Gate question 1 — "did we accidentally create duplicate
planners/brokers/routers?" — with *yes*, at roughly 3× the current 8,900-line source
tree, for no measurable token.

## Finding 4 — Part X (sandbox/snapshot/warm pools) fails its own gate

The plan gates warm pools on execution-overhead ratio being material (Task 23, Advanced
Feature B). It is not. In the measured run, dispatch wall-clock was 26s–263s against
Job startup of a few seconds, and the 4m22s of latency that did hurt was *queue* wait
behind `DEFAULT_MAX_CONCURRENT = 2` — a concurrency policy, not a startup cost. Snapshot
and warm-pool machinery would be built to save seconds on a path where the unbounded
term costs minutes. Gate not cleared; not implemented.

## Finding 5 — budget authority is advisory

`budget_usd` is consulted when *deciding* (`decideExecution`'s escalation floor,
`routeModel`'s `BUDGET_PRESSURE`) and never again. Nothing stops a running task tree
from spending past it; the measured run spent $2.65 against `budget_usd: 0`. "Cost per
successful task" is not an objective the system can currently enforce, only one it can
report after the fact. The plan asks for bounded escalation with a spend budget (Task 26
step 5) but only inside the router.

## Red-team answers (plan Task 0, Step 5)

1. **Is the Context Graph needed?** No. Content identity, versioning and provenance are
   already served by the append-only `events` chain plus `artifacts`; a second store
   indexing content we do not put in a prompt has no reader.
2. **Is the Decision Engine a new abstraction?** No — a wrapper over
   `decompose`/`economics`/`decide-execution`/`model-router`.
3. **Can context objects, cache entries and execution artifacts share one model?** They
   already do: `memory(kind, key, value, nodeId)` backs the plan cache, repo-inventory
   cache, model-route records and efficiency records.
4. **Does projection planning cost more than it saves?** At 22–46 argv tokens per Job,
   any planner more expensive than the current pure-function selector does, yes.
5. **Which caches can go stale?** Plan cache (goal+HEAD, clean tree only, TTL) and the
   new result cache (same rule, plus read-only grant). Both refuse a dirty tree.
6. **Necessity vs extension point?** Turn budget and spend breaker are necessities;
   everything in Parts III–VII and X is an extension point with no measured demand.
7. **Is warm-sandbox work justified?** No — Finding 4.
8. **Can adapters support reference-first / delta context?** Not without owning the
   context window. `buildCommand` takes one string.
9. **Is Postgres sufficient?** The question is moot: this runtime is SQLite/Drizzle
   (`better-sqlite3`, `src/db/migrations/*`), single-daemon, and the plan's PostgreSQL
   premise does not match the repository.
10. **Is there a simpler design with the same economics?** Yes — this one.

## Decision

**Reform.** Implement the four changes below; do not implement Parts III–VII or X.

| # | Change | Term it moves | Evidence |
|---|---|---|---|
| 1 | `execute` turn budget as a circuit breaker, and the agent *told* its budget so it summarises instead of being cut off | the unbounded term: turns × prefix growth | diagnosis §"Top remaining bottleneck"; 19/30/42-turn spread measured |
| 2 | Task spend breaker at the single `dispatch()` chokepoint | enforces cost-per-task instead of reporting it | Finding 5 |
| 3 | Result reuse for read-only dispatches, keyed as the plan cache is | whole dispatches avoided | doctrine rung 2 (reuse); plan Task 28 |
| 4 | Ledger records avoided execution and tokens avoided | makes 1–3 measurable rather than asserted | plan Task 1 steps 1/3 |
| 5 | Dependency-based cache validity from the run's own tool stream | a HEAD-keyed cache dies on every commit; this one survives unrelated ones | plan Tasks 3, 20, 21 (Task 21 step 5 asks for exactly this) |
| 6 | Critical-path priority in the sandbox queue | p95: a 1-turn synthesis was queueing behind a 60-turn execution | plan Task 19 |
| 7 | Execution-overhead telemetry (`startupMs`, `executionOverheadRatio`) | decides the Part X gate with a number instead of an assertion | plan Task 23 |
| 8 | Decision replay (`org decision --replay`) | turns the auditability claim into a command | plan Task 31 |
| 9 | `blocked` / `needs_input` child statuses | an unrecognised status discards the whole envelope and buys a synthesis call | plan Task 14 |

Changes 5–9 were added in a second pass after re-auditing the rejected tasks: each is a
plan task whose *intent* survives translation to this architecture even though its proposed
mechanism does not. Task 3's "dependency fingerprints and partial invalidation" is the
clearest case — the plan builds them over Context Objects we do not have, and the same
property falls out of the tool stream we do have.

Each is deterministic, adds no hot-path model call, degrades to current behaviour on
failure, and is verifiable without spending a token on inference.

## What is deliberately not built, and what would change that

| Not built | Would be justified by |
|---|---|
| Context objects / graph / RPC (Tasks 2–4, 8) | CherryOnTop owning the model context window — i.e. an adapter that drives the agent turn-by-turn instead of `claude -p` |
| Observation engine / tool projections / evidence planner (Tasks 10–12) | same. Note the *stream* is now read — for dependency fingerprints, where it pays — but reducing what we store in it still saves no model token |
| Snapshots / warm pools / workspace forks (Tasks 22–25) | `executionOverheadRatio` measured above ~15% of successful-task latency |
| Provider routing split (Task 27) | a second provider actually configured |
| Learned ranking / utility memory / shadow harness (Tasks 29–31) | a deterministic selector shown to be the binding constraint |
| PostgreSQL dependency layer (Task 2 step 5) | SQLite contention measured under real concurrency |
