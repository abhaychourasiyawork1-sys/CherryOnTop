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
| 23b | Uncertainty widens *generation*, not only selection | `context/candidates.ts` (centrality seeding) | `candidates.test.ts` ("falls back to what the repository depends on"), `architecture/invariants.test.ts` |
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
| 62 | A child owns execution of its assignment; its parent owns the decision that it is acceptable | `lifecycle/delegate-child.ts` (`driveAssignment`), `lifecycle/delegation-review.ts` | `delegation-rework.test.ts` ("walks the whole contract"), `delegation-review.test.ts` |
| 63 | Child completion is `REPORT_READY`, not acceptance or merge | `schemas/delegation.ts` (transition table), `db/queries/delegations.ts` | `delegations.test.ts` ("will not merge what the parent has not accepted"), `delegation-invariants.test.ts` |
| 64 | Only `ACCEPTED` work merges; the gate is a refused transition, not a convention | `lifecycle/node-actor-manager.ts` `mergeAcceptedDelegation` | `delegation-merge.test.ts` ("will not merge a child that was never reviewed, even though its node is COMPLETE") |
| 65 | Failed acceptance → same child, same assignment, same worktree, next revision, structured feedback | `delegate-child.ts` `requestRework`, `delegation-reports.ts` | `delegation-rework.test.ts` ("sends a failed acceptance back to the same child"), `delegation-lifecycle.test.ts` |
| 66 | Reassignment is exceptional: explicit decision, reason and decider recorded, budget-capped, never reached by the failure path | `delegate-child.ts` `requestReassignment` | `delegation-rework.test.ts` ("reassignment is an explicit decision, never a retry"), `delegation-lifecycle.test.ts` |
| 67 | An integration conflict is `INTEGRATION_BLOCKED`, not an implementation failure, and leaves the parent tree exactly as it was | `node-actor-manager.ts` `integrateFork` (snapshot/restore), `mergeAcceptedDelegation` | `fork-isolation.test.ts` ("leaves the base exactly as it was"), `delegation-merge.test.ts`, `delegation-lifecycle.test.ts` |
| 68 | The node state machine is untouched; the parent/child relationship is a durable projection | `db/schema.ts` `delegations`, `schemas/delegation.ts` | `delegation-merge.test.ts` (node stays `COMPLETE` through a blocked merge) |
| 69 | The economic governor may rework, reassign, escalate or cancel — it cannot accept | `delegate-child.ts` `RecoveryDecision`, `recoveryDecision` | `delegation-rework.test.ts` ("the economic governor cannot override a hard acceptance failure") |
| 70 | Delegation is recursive: a child can assign, review and merge its own children, bounded by its own authority | `node-actor-manager.ts` `createChildNode`, `delegate-child.ts` | `delegation-invariants.test.ts` ("a child can become a parent") |
| 71 | Every status change is audited once, through the tamper-evident log, by the operation that made it | `lifecycle/delegation-events.ts` `transitionDelegation` | `delegation-events.test.ts` |
| 72 | A cancelled child or stopped parent is never reworked, replaced or merged | `delegate-child.ts` `cancelAssignment` | `delegation-rework.test.ts` ("stopping is not failing"), `delegation-lifecycle.test.ts` |
| 73 | Unaccepted work stays isolated: every write-capable child forks, a failed review keeps its worktree, retained candidates survive the orphan sweep | `node-actor-manager.ts` `createChildNode`, `db/queries/delegations.ts` `listRetainedWorkspacePaths` | `fork-isolation.test.ts`, `delegations.test.ts` ("retained workspaces"), `delegation-invariants.test.ts` |

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
| Delegation: event helper (Task 7) landed before the runtime tasks | Every transition in Tasks 2–6 writes through it; building them first would have meant writing each transition twice. |
| Delegation: Tasks 4 and 5 implemented as one loop | Review, rework and reassignment are one control flow (`driveAssignment`). Splitting them left an intermediate state where a failed review had nowhere to go. Their tests are still separate files. |
| `settleFork` removed rather than kept as a "low-level merge helper" | The plan allowed either. Keeping an exported function that integrates whatever it is handed is exactly the footgun the gate exists to remove; `integrateFork` stays as the mechanical primitive and `mergeAcceptedDelegation` is its only production caller. |
| Reassignment opens a *new* assignment row (`reassignedFrom`) instead of changing `childId` on the old one | The old row keeps its report, feedback and child intact, so "old ownership lineage preserved" is a property of the data rather than of the event log. |
| Every write-capable child forks, including a lone one | Isolation used to be justified only by races between siblings. The parent now reviews a candidate before accepting it, and a lone child editing the parent's tree has already merged before anyone looked. The old "shares the parent path for a single child" test is replaced, with the reason in the file. |
| Acceptance runner reads evidence; it does not execute commands | A check is met by a passing verifying command in the candidate's own trace or a fresh result from an injected verifier (`file:<path>` is built in). Running planner-authored shell strings on the daemon host would bypass the sandbox model, and the ladder has no V3 verifier for the same reason. Silence is a failure, never a pass. |
| `schemas/node-contract.ts` unchanged | The child's DoD and the parent's acceptance checks live on the assignment, not the node contract: the contract is a snapshot of what a node may do, and the plan's own constraint is not to overload node state. |

## Root-cause fixes found during implementation

Each was a latent defect surfaced by a new test, fixed at its source rather than
at the call site that exposed it.

| Defect | Found by | Fix |
|---|---|---|
| `explorationAvoided` scored a lexically-matched file at zero — "the agent already knows about it", which is false | the economic gate in `selector.ts` | `context/scoring.ts`: separate "is it needed?" from "would finding it cost anything?". Anchors and structural neighbours score exactly as before. |
| "Uncertainty widens" was applied to selection while the candidate set was empty, so it widened nothing | the frozen baseline receipts | `context/candidates.ts`: centrality seeding when nothing is anchored. Widening now happens where the candidates are made. |
| Workstream ordering stated from the producing side was detected but applied backwards | `workstreams.test.ts` | directed ordering edges built once; pairwise conflict left to write-path overlap alone |
| `tombstoneFor` recorded a named hypothesis without invalidating it | `five-layer.test.ts` | naming a hypothesis now invalidates it and removes it from what the next attempt inherits |
| A safety violation attributed to a rejected candidate was invisible to the fallback | `degradation.test.ts` | reason-code check matches `rejected:<id>:safety_violation` too |
| A zero optimization allowance was not treated as exhausted | `degradation.test.ts` | it is; otherwise Baseline behaviour appears in the Full column of every comparison |
| `validateMetadata` compared whole policy ids, refusing every valid two-arm comparison | `compare.test.mjs` | compares the generation, not the architecture prefix |
| The orchestration allowance was scoped to the context planner's budget, putting the screening bar at ~0.98 | `economic-runtime.test.ts` | uses the task's own allowance; choosing context is one thing the orchestrator spends on, not all of it |
| `git apply --3way` left conflict markers and unmerged index entries in the authoritative tree when a real conflict was refused, while `integrateFork` reported only `false` | `fork-isolation.test.ts` ("leaves the base exactly as it was") | `integrateFork` snapshots the worktree and index state of every path the patch touches and restores it on failure. `INTEGRATION_BLOCKED` now means the base was not touched. |
| A finished node's deferred cleanup (`setTimeout(() => actors.delete(nodeId))`) deleted the actor of a node re-entered in the meantime, so a same-child rework failed with "No active actor" | `node-actor-manager.test.ts` ("keeps a re-entered node's actor registered") | The cleanup removes only its own entry. |
| A delegated child that itself delegated forked from its container-form `repoPath`, which does not exist on the host, so its children silently shared its tree — isolation held one level deep | `delegation-invariants.test.ts` ("a child can become a parent") | Forks are taken from the host path (`fromContainerPath`). |
| A reworked child's parent review read the child's whole exec history, where a failure signature never clears — so a check red in revision 1 stayed red after a green re-run in revision 2 and no rework could converge | `delegation-run-result.test.ts` | The review's observed checks are scoped to events since the child's last `delegation.reworking` (`childRunResult`); the node's own validation is unchanged. |

## What is not done

| | |
|---|---|
| The paid matched benchmark | Not run. [Report](../benchmarks/2026-09-14-full-architecture-baseline-comparison.md) says what is measured and what is not. |
| Policy tuning | None, and none is justified without the above. [Log](../benchmarks/2026-09-14-policy-tuning-log.md). |
| The information-poor regime | **Addressed after the plan, unmeasured.** A goal with no anchors now seeds structural relevance from import-graph centrality — the one kind of structural evidence that needs no anchor. `Review the codebase and find bugs` goes from 2 candidates to 227 and now surfaces the most-depended-on modules instead of a migration filename. Whether it *helps* is a question for the paid run. |
| Live V3 validation | The ladder stops at V2 — this runtime cannot re-run a repository's suite from inside the daemon. Recorded as `V3:no_verifier` rather than left to be inferred. |
| Workstream scheduling in delegation | **Closed.** `delegateToChildren` builds a plan with `planWorkstreams` (`workstreamNodesFor`) and runs groups in order; the assignment lifecycle sits on top of it and does not change ordering or parallelism. |
| Cross-run knowledge writing | The store, reuse pricing and candidate source exist and are wired for *reading*. Nothing writes a `KnowledgeItem` at the end of a run yet, so `memoryNetValue` will read zero until something does. |
| Before/after delegation benchmark | **Not run.** It needs paid model dispatches. The metrics it must report are: successful tasks, child dispatches, rework dispatches, reassignments, merges, rejected merges, cost, turns, wall time and correctness. No claim of improved cost or success rate is made here; what is claimed is behavioural and proved by the tests above. |
| Planner-supplied contracts | `DelegateInput` accepts per-piece definitions of done and parent acceptance checks (`definitionOfDoneBySubgoal`, `acceptanceChecks`, `acceptanceChecksBySubgoal`) and stores them durably, but the planner does not yet emit them, so production runs default to the subgoal as DoD and no *extra* parent checks. Base acceptance (the child's own validation, authority, ordering) still gates every merge. |
| Model- or market-driven reassignment | The only production governor is budget-based (`decideRecovery` escalates when a child cannot fund another revision). The hook accepts richer decisions from the Action Market or a person; nothing produces a reassignment decision yet, so reassignment only happens when something explicitly asks for it. |
| Fresh (V3) acceptance verification | Parent checks are met by evidence in the candidate's trace, or by an injected verifier (`file:<path>` exists in the candidate). Re-running the repository's suite against the candidate is the same capability gap as V3 above. |
| `control-loop.integration.test.ts` | Not extended: it needs a cluster. `delegation-lifecycle.test.ts` covers the same paths on the real ledger, git workspaces and event log with only child execution simulated. |
