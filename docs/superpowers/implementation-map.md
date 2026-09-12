# Implementation map — context/execution runtime work on `feat/token-efficiency`

Scope is the reformed architecture recorded in
[the critique ADR](architecture-decision-records/2026-09-12-runtime-architecture-critique.md).
Four changes; everything else in the source plan is either already implemented under a
different name or rejected there with the evidence.

## Current owners (archaeology result — do not duplicate these)

| Concern | File | Symbols |
|---|---|---|
| Task path | `src/lifecycle/node-actor-manager.ts` | `productionMachine`, `dispatch`, `planSubgoals`, `synthesizeChildren`, `recordUsage`, `modelChoiceFor` |
| Sandbox dispatch | `src/execution/execute-step.ts` | `executeStep`, `ExecuteStepInput.maxTurns` |
| Splittability / difficulty | `src/intelligence/decompose.ts` | `assessDecomposition` |
| Delegation economics | `src/engines/decide-execution.ts`, `src/engines/economics.ts` | `decideExecution`, `scoreDelegation`, `counterfactual` |
| Model routing | `src/intelligence/model-router.ts` | `routeModel` |
| Conditional synthesis | `src/intelligence/integrate-results.ts` | `decideIntegration` |
| Context projection | `src/context/dispatch-context.ts`, `src/context/dispatch-context-cache.ts` | `selectDispatchContext`, `DispatchReceipt`, `dispatchContextFor`, `repoInventoryFor` |
| Accounting | `src/efficiency/{metrics,ledger,objective}.ts` | `buildEfficiencyRecord`, `createEfficiencyLedger`, `evaluateExperiment` |
| Caches | `src/db/queries/plan-cache.ts`, `src/db/queries/repo-map-cache.ts` | `planCacheKey`, `getCachedPlan`, `putCachedPlan` |
| Config surface | `src/config/efficiency.ts` | `dispatchOptionsFor`, `efficiencyMode`, `maxChildJobs` |
| Role prompts | `src/prompts/roles.ts` | `buildRolePrompt`, `stanza` |

## Task 1 — `execute` turn budget

| | |
|---|---|
| Files | `src/config/efficiency.ts`, `src/prompts/roles.ts`, `src/lifecycle/node-actor-manager.ts` |
| Reuse | `dispatchOptionsFor`, `ExecuteStepInput.maxTurns` (already plumbed to argv), `RolePromptParams` |
| Modify | `MAX_TURNS_DEFAULT`, `stanza('execute')`, the `buildRolePrompt('execute', …)` call site |
| New | `ORG_MAX_TURNS_EXECUTE` (default 60, `0` = uncapped); `RolePromptParams.maxTurns` |
| Tests | `src/config/efficiency.test.ts`, `src/prompts/roles.test.ts` |
| Depends on | — |

## Task 2 — task spend breaker

| | |
|---|---|
| Files | `src/execution/budget.ts` (new), `src/lifecycle/node-actor-manager.ts` |
| Reuse | `dispatch()` chokepoint (already holds the terminal-state guard), `getCostForNodes`, `Authority.budget_usd` |
| New | `budgetExceeded()` |
| Tests | `src/execution/budget.test.ts`, `src/lifecycle/dispatch-budget.test.ts` |
| Depends on | — |

## Task 3 — read-only result reuse

| | |
|---|---|
| Files | `src/db/queries/result-cache.ts` (new), `src/config/efficiency.ts`, `src/lifecycle/node-actor-manager.ts` |
| Reuse | `memory` table, `repoHead`/`repoDirty`, the plan cache's clean-tree + TTL validity rule, `publishAnswer`, `publishProgress` |
| New | `resultCacheKey`, `getCachedResult`, `putCachedResult`, `resultCacheTtlHours` |
| Tests | `src/db/queries/result-cache.test.ts`, `src/lifecycle/result-reuse.test.ts` |
| Depends on | Task 4 (records the hit) |

## Task 4 — avoided-work accounting

| | |
|---|---|
| Files | `src/efficiency/metrics.ts`, `src/efficiency/ledger.ts`, `src/efficiency/objective.ts` |
| Reuse | `EMPTY_TOTALS`, `buildEfficiencyRecord`, `recordAvoided` |
| Modify | `recordAvoided` gains `execute` and a token estimate; `EfficiencyInput` gains `avoidedExecutionCalls`, `tokensAvoided`; `EfficiencyRecord` gains `workAvoidedRatio`; `SuiteSummary` gains `tokensAvoided`/`workAvoidedRatio` |
| Tests | `src/efficiency/{metrics,ledger,objective}.test.ts` |
| Depends on | — |
