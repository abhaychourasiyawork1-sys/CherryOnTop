# Implementation audit

Every architectural invariant from the plan, where it lives, and the test that
proves it. An invariant with no test is an intention, and this table is what
stops the difference from being invisible.

Commit: `3699290` · 150 test files · 1697 unit tests · 12 integration · 1 e2e ·
81.9% statements / 76.2% branches.

## Invariants

| # | Invariant | Implementation | Test |
|---|---|---|---|
| 1 | One generic state contract; no task-specific fields | `decision/state.ts` | `state.test.ts`, `architecture/invariants.test.ts` ("no task-class vocabulary") |
| 2 | State snapshots are values; the reducer never mutates | `decision/state.ts` `applyEconomicEvent` | `state.test.ts` ("never mutates the previous snapshot") |
| 3 | Normalization is total; a bad state cannot become a bad dispatch | `decision/state.ts` `normalizeEconomicState` | `state.test.ts` (bounds, idempotence, arbitrary sequence) |
| 4 | One action shape for every capability; detail in metadata | `decision/actions.ts` | `actions.test.ts` ("requires no task category", "carries detail in metadata") |
| 5 | Objective is 2:2:1, per action and per suite | `decision/utility.ts`, `efficiency/objective.ts` | `utility.test.ts` ("the 2:2:1 objective"), `objective.test.ts` ("carries the 2:2:1 objective") |
| 6 | Hard constraints evaluated before the score, unbuyable | `decision/utility.ts` | `utility.test.ts` ("hard constraints outrank the score") |
| 7 | Quality floor cannot be bought by a token saving | `decision/utility.ts` | `utility.test.ts` ("rejects an action whose quality risk breaches the floor") |
| 8 | Ranking is deterministic; ties break on confidence then id | `decision/engine.ts` | `engine.economic.test.ts` ("deterministic ranking") |
| 9 | The default is non-intervention | `decision/engine.ts` | `engine.economic.test.ts` ("the conservative fallback") |
| 10 | Every decision records state version and reason codes | `decision/engine.ts` | `engine.economic.test.ts` ("decision provenance") |
| 11 | Cheap screen before any expensive evaluation | `decision/fast-path.ts` | `path.test.ts` ("costs nothing and usually says no"), `orchestration-loop.test.ts` |
| 12 | The screening bar is economic, not a constant | `decision/fast-path.ts` | `path.test.ts` ("the screening bar is economic, not constant") |
| 13 | The deep path proposes and never chooses | `decision/deep-path.ts` | `path.test.ts` ("the deep path proposes") |
| 14 | The deep path cannot recurse into itself | `decision/deep-path.ts` | `path.test.ts` ("is not recursively invoked by itself") |
| 15 | Uncertainty is four independent dimensions | `decision/uncertainty.ts` | `uncertainty.test.ts` ("the dimensions are independent") |
| 16 | Repeated evidence cannot manufacture confidence | `decision/uncertainty.ts` | `uncertainty.test.ts` ("cannot be walked to certainty by repeating one read") |
| 17 | Removing doubt has diminishing returns | `decision/uncertainty.ts` | `uncertainty.test.ts` ("diminishing returns") |
| 18 | Productive exploration stays viable | `decision/trajectory.ts` | `trajectory.test.ts`, `architecture/invariants.test.ts` ("no universal stuck threshold") |
| 19 | State fingerprint is about subjects, not tool calls | `efficiency/progress-signals.ts` `executionSnapshot` | `progress-signals.test.ts` ("the fingerprint"), `trajectory.test.ts` |
| 20 | Evidence has explicit levels L0–L3 | `context/candidates.ts` | `candidates.test.ts` ("evidence levels L0 to L3") |
| 21 | L3 is priced, never materialized, by the selector | `context/candidates.ts`, `selector.ts` | `candidates.test.ts` ("never renders a full artifact"), `selector.test.ts` ("full-artifact requests") |
| 22 | Selection is economic, not only relevance ranking | `context/selector.ts` | `selector.test.ts` ("the economic gate") |
| 23 | Uncertainty widens selection rather than pruning | `context/selector.ts` | `selector.test.ts` ("suspends the gate while widening") |
| 24 | Provide-now-vs-discover-later is priced | `efficiency/information-economics.ts` | `information-economics.test.ts` |
| 25 | Optimization overhead is inside expected cost | `efficiency/information-economics.ts`, `decision/utility.ts` | `information-economics.test.ts` ("the optimizer charges itself") |
| 26 | Reactive acquisition is one artifact, bounded, re-priced | `context/evidence-actions.ts` | `evidence-actions.test.ts` ("the bounds that stop this becoming expensive") |
| 27 | No live Context RPC; the existing boundary is reused | `lifecycle/node-actor-manager.ts` `economicBoundary` | `economic-runtime.test.ts` ("dispatches exactly the prompt the context planner alone would have built") |
| 28 | Budget allocation follows opportunity, not a table | `decision/budget.ts` | `budget.test.ts`, `architecture/invariants.test.ts` ("no fixed task-to-budget percentages") |
| 29 | Nothing is held back for work nobody proposed | `decision/budget.ts` | `budget.test.ts` ("nothing is held back") |
| 30 | The recovery reserve releases itself | `decision/budget.ts` | `budget.test.ts` ("appears and disappears with the reason for it") |
| 31 | The loop charges itself | `decision/orchestration-cost.ts` | `orchestration-loop.test.ts` ("orchestrationCostOf") |
| 32 | Reassessment frequency adapts | `decision/orchestration-loop.ts` | `orchestration-loop.test.ts` ("adaptive reassessment frequency") |
| 33 | The loop cannot optimize itself | `decision/orchestration-loop.ts` | `orchestration-loop.test.ts` ("cannot optimize itself") |
| 34 | The agent stays the reasoner; CONTINUE is a true no-op | `lifecycle/economic-runtime.ts` | `economic-runtime.test.ts` ("the agent executes unchanged"), `five-layer.test.ts` |
| 35 | State is built from telemetry that already existed | `lifecycle/economic-runtime.ts` | `economic-runtime.test.ts` ("assembled from what the runtime already records") |
| 36 | One fallback with many reasons; Baseline is it | `decision/fallback.ts` | `fallback.test.ts` ("every ordinary fault lands in the same place") |
| 37 | Doubt reduces intervention, from the top down | `decision/trust.ts`, `fallback.ts` | `trust.test.ts`, `fallback.test.ts` ("shrinks the eligible set from the top down") |
| 38 | A safety failure blocks rather than falls back | `decision/fallback.ts` | `fallback.test.ts`, `degradation.test.ts` ("refused, never merely un-optimized") |
| 39 | Failing to optimize never fails the work | everywhere (total functions) | `degradation.test.ts` ("failing to optimize never fails the work") |
| 40 | EXECUTION_FINISHED cannot become TASK_SUCCESS | `validation/engine.ts`, `node-actor-manager.ts` | `validation/engine.test.ts` ("finishing is not succeeding"), `economic-runtime.test.ts` |
| 41 | Validation stops at the cheapest sufficient level | `validation/engine.ts` | `engine.test.ts` ("the cheapest sufficient level") |
| 42 | Recovery preserves observed evidence | `recovery/engine.ts` | `recovery/engine.test.ts`, `five-layer.test.ts` |
| 43 | A disproven hypothesis stays disproven | `recovery/engine.ts` | `recovery/engine.test.ts` ("a disproven belief stays disproven") |
| 44 | Knowledge is versioned and provenance-backed | `evidence/store.ts`, `db/schema.ts` | `store.test.ts`, `db/schema.test.ts` |
| 45 | Retrieval is bounded and cheap | `evidence/store.ts` | `store.test.ts` ("retrieval is bounded") |
| 46 | **Current evidence outranks historical** | `evidence/reuse.ts` | `reuse.test.ts`, `architecture/invariants.test.ts` |
| 47 | Parallelism is scheduled economically, never by rule | `execution/workstreams.ts` | `workstreams.test.ts` ("a candidate, never a rule") |
| 48 | Shared information does not order work | `execution/workstreams.ts` | `workstreams.test.ts`, `five-layer.test.ts` |
| 49 | Write conflicts prevent unsafe parallel execution | `execution/workstreams.ts` | `workstreams.test.ts`, `five-layer.test.ts` |
| 50 | Unrelated failure does not cancel healthy work | `execution/conflicts.ts` | `conflicts.test.ts` ("an unrelated failure must not cancel healthy work") |
| 51 | Contradictions recorded, precedence stated | `execution/conflicts.ts`, `evidence/store.ts` | `conflicts.test.ts`, `store.test.ts` ("recording a contradiction") |
| 52 | Events are typed, versioned and idempotent | `events/economic-events.ts` | `economic-events.test.ts` ("duplicate delivery cannot spend twice") |
| 53 | Ledger records prediction vs outcome and regret | `efficiency/ledger.ts`, `metrics.ts` | `ledger.test.ts` ("prediction against outcome") |
| 54 | Unreconciled decisions are not credited zero | `efficiency/metrics.ts` | `ledger.test.ts`, `metrics.test.ts` |
| 55 | Policy generations are immutable and comparable | `efficiency/policy-version.ts` | `policy-version.test.ts` |
| 56 | **Exactly two product runtime modes** | `config/efficiency.ts` | `efficiency-rollout.test.ts`, `policy-version.test.ts`, `architecture/invariants.test.ts` |
| 57 | No task-specific routing anywhere in the decision layer | — (absence) | `architecture/invariants.test.ts` (source scan) |
| 58 | No count-against-constant stuck rules | — (absence) | `architecture/invariants.test.ts` (source scan) |
| 59 | Benchmark compares matched runs | `bench/compare.mjs` | `compare.test.mjs` |
| 60 | Benchmark reports tokens per success first | `bench/metrics/economic.mjs` | `economic.test.mjs` ("the report") |
| 61 | Regimes prevent tuning against one task pattern | `bench/goals.json`, `regimes.md` | `bench/metrics/regimes.test.mjs` |

## Economic behaviours

Each has both a test and a benchmark signal. "Benchmark signal" means a metric
the harness reports that would move if the behaviour broke.

| Behaviour | Test | Benchmark signal |
|---|---|---|
| information-now-vs-later economics | `information-economics.test.ts` | `initialContextTokens`, `explorationTokens` |
| uncertainty reduction | `uncertainty.test.ts` | `explorationTokens`, `evidenceTokens` |
| dynamic budgeting | `budget.test.ts` | per-bucket token columns |
| agent-first non-intervention | `economic-runtime.test.ts` | `orchestrationTokens`, `interventions` |
| reactive evidence | `evidence-actions.test.ts` | `evidenceTokens`, `beneficialInterventionRate` |
| validation economics | `validation/engine.test.ts` | `validationTokens`, `successRate` |
| evidence-preserving recovery | `recovery/engine.test.ts` | `recoveryTokens` |
| workstream economics | `workstreams.test.ts` | `duplicatedInformationTokens`, `duplicationRatio` |
| historical evidence reuse | `reuse.test.ts` | `memoryNetValue` |
| optimization overhead | `orchestration-loop.test.ts` | `orchestrationOverheadRatio`, `optimizationRoi` |
| safe fallback | `degradation.test.ts` | `economic.fallback` events, `tasksStopped` |

## Deviations from the plan, and why

The plan grants engineering freedom for changes that improve the goal, and
forbids using "less work" as a reason. Each of these was taken for a stated
reason and is recorded in its commit.

| Deviation | Reason |
|---|---|
| `UtilityWeights` typed `number` rather than the literal `0.4\|0.4\|0.2` | Literal types make the `weights` parameter unusable — the only assignable value is the default. The 2:2:1 contract is pinned by test on the constant instead. |
| Task 11 implemented before Task 9 | Task 9 step 2 needs the pricing Task 11 defines. Implementing in plan order would have meant writing it twice. |
| `engine.economic.test.ts` split from `engine.test.ts` | The legacy receipt API and the state/action evaluator are separate contracts; one file asserting both hides which is which. |
| `lifecycle/economic-runtime.ts` created rather than growing `node-actor-manager.ts` | The boundary between the state machine and the control plane is exactly the boundary that has to stay legible for the invariants to be checkable. |
| `execute-step.ts` unmodified (Tasks 10, 20) | The execution boundary the plan asks to reuse is the lifecycle's goal preparation, which already exists. Adding a parameter to `executeStep` would be a second boundary, not a reuse of the first. |
| `decision/actions.ts` unmodified (Tasks 17, 20, 21) | Recovery and scheduling reach the engine as ordinary candidates through the generic contract that file already provides. Editing it would add a capability-shaped special case to the layer whose point is not having one. |
| Trust integrated at ranking rather than inside `evaluateActionUtility` | The utility model answers what an action is worth; trust answers whether to believe that. Mixing them makes neither answerable alone, and `fallback.ts` already owns the hard confidence gate. |
| `evidence_conflicts` table added in migration 0008 | Task 26 needs it; two migrations for one feature is churn a reader has to reassemble. |
| Generation constants moved to `policy-version.ts` | Defining them beside the weights while composing them elsewhere made the modules import each other — a cycle that works under ESM hoisting and stops working the first time either needs a module-scope value. |
| `five-layer.test.ts` not `.integration.test.ts` | The unit suite excludes lifecycle integration tests as cluster-dependent; this needs only git and sqlite, and excluding it would leave the composition checked by nothing that runs by default. |
| `bench/**/*.test.mjs` added to the unit suite | Pure functions over synthetic records. The arithmetic that decides whether a change ships should be checked by the suite that runs on every change. |

## Root-cause fixes found during implementation

Each was a latent defect surfaced by a new test, fixed at its source rather than
at the call site that exposed it.

| Defect | Found by | Fix |
|---|---|---|
| `explorationAvoided` scored a lexically-matched file at zero — "the agent already knows about it", which is false | the economic gate in `selector.ts` | `context/scoring.ts`: separate "is it needed?" from "would finding it cost anything?". Anchors and structural neighbours score exactly as before. |
| Workstream ordering stated from the producing side was detected but applied backwards | `workstreams.test.ts` | directed ordering edges built once; pairwise conflict left to write-path overlap alone |
| `tombstoneFor` recorded a named hypothesis without invalidating it | `five-layer.test.ts` | naming a hypothesis now invalidates it and removes it from what the next attempt inherits |
| A safety violation attributed to a rejected candidate was invisible to the fallback | `degradation.test.ts` | reason-code check matches `rejected:<id>:safety_violation` too |
| A zero optimization allowance was not treated as exhausted | `degradation.test.ts` | it is; otherwise Baseline behaviour appears in the Full column of every comparison |
| `validateMetadata` compared whole policy ids, refusing every valid two-arm comparison | `compare.test.mjs` | compares the generation, not the architecture prefix |
| The orchestration allowance was scoped to the context planner's budget, putting the screening bar at ~0.98 | `economic-runtime.test.ts` | uses the task's own allowance; choosing context is one thing the orchestrator spends on, not all of it |

## What is not done

| | |
|---|---|
| The paid matched benchmark | Not run. [Report](../benchmarks/2026-09-14-full-architecture-baseline-comparison.md) says what is measured and what is not. |
| Policy tuning | None, and none is justified without the above. [Log](../benchmarks/2026-09-14-policy-tuning-log.md). |
| The information-poor regime | **Not fixed.** A goal with no anchors gets no structural seeds, because structural relevance is measured *from* anchors. `Review the codebase and find bugs` still finds two candidates. Candidate generation is the limit; nothing in this plan changed it. The most concrete known gap. |
| Live V3 validation | The ladder stops at V2 — this runtime cannot re-run a repository's suite from inside the daemon. Recorded as `V3:no_verifier` rather than left to be inferred. |
| Workstream scheduling in delegation | `planWorkstreams` and `schedulingCandidates` are built and tested; `delegateToChildren` does not yet build a plan from its children. The decision layer is ready for it. |
| Cross-run knowledge writing | The store, reuse pricing and candidate source exist and are wired for *reading*. Nothing writes a `KnowledgeItem` at the end of a run yet, so `memoryNetValue` will read zero until something does. |
