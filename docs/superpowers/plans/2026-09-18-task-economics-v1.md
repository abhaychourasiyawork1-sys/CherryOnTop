# Task Economics V1 Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

Goal: Make execution decisions account for whole-task economics without rebuilding CherryOnTop's existing recursive budget inheritance.

Architecture: Add a deterministic task-level economics layer that (1) recognizes a cheap fast path for tiny, anchored, unambiguous work, (2) rejects delegation unless modeled benefit clears a configurable margin over coordination/planning/verification cost, and (3) exposes a reservation-style resource envelope for a root task and descendants. Reuse the existing authority/budget propagation; do not replace it. Keep hot-path calculations deterministic and auditable.

Tech Stack: TypeScript, Vitest, existing CherryOnTop decision/economics modules.

Spec: Derived from the paid benchmark report and the current feat/token-efficiency-architecture branch. The benchmark reports 46.7% higher tokens/success, 41.7% more turns/success, and 31.3% higher p95 latency for Full Architecture. hard-budget is 155% higher tokens/success and strategy-failure is 117% higher. Quality was not scored and the benchmark had cross-goal repository mutation, so paid results remain provisional.

## Global Constraints

- Do not add a model call to the hot path for the economics controller.
- Preserve the existing child budget/subtree inheritance in src/lifecycle/delegate-child.ts.
- Preserve operator hard budget and turn-cap semantics.
- A task that is not confidently worth delegating must self-execute.
- A near-threshold delegation score must not delegate merely because of floating-point tolerance.
- Fast-path decisions must be deterministic and covered by unit tests.
- Do not claim benchmark improvement until a matched paid run is executed with repository isolation and quality scoring.

---

## Task 1: Deterministic task-resource envelope

Files:
- Create: src/efficiency/task-envelope.ts
- Test: src/efficiency/task-envelope.test.ts

Interface:
- TaskResourceEnvelope with remainingBudgetUsd, remainingTurns, remainingTokens, remainingDelegations.
- createTaskResourceEnvelope(input).
- canAfford(envelope, reservation).
- reserveForDelegation(envelope, reservation).
- remainingEnvelope(envelope).

Behavior to test:
- Root resources are normalized to non-negative values.
- A reservation that exceeds any single resource is rejected.
- A valid reservation decreases all four resources without mutation.
- Remaining resources are stable and serializable.

Implementation rule: this layer is pure bookkeeping. It does not replace existing authority propagation; it supplies a task-level reservation model that can later be wired to actual consumption.

---

## Task 2: Delegation break-even margin

Files:
- Modify: src/engines/economics.ts
- Test: src/engines/economics.test.ts

Behavior:
- Preserve the current score formula.
- Add optional minimumMargin to EconomicsInput.
- Return margin and breakEvenThreshold.
- Delegate only when score minus threshold clears minimumMargin.
- Keep backward compatibility when minimumMargin is omitted.
- Remove the use of a floating-point tolerance as a reason to overcome a positive margin.

Critical regression case:
- A score of 0.301 with threshold 0.3 and minimumMargin 0.01 must NOT delegate.
- A score of 0.32 with threshold 0.3 and minimumMargin 0.01 must delegate.

---

## Task 3: Deterministic fast path

Files:
- Create: src/efficiency/fast-path.ts
- Test: src/efficiency/fast-path.test.ts

Fast-path eligibility:
- worthSplitting is false.
- Exactly one concrete anchor exists.
- Complexity is low.
- Task class is trivial_edit or documentation.
- Goal is not broad repository work.

The result must include eligible, confidence, and reason. No semantic model call is allowed.

---

## Task 4: Integrate the two policies

Files:
- Modify: src/decision/engine.ts
- Modify: src/engines/decide-execution.ts
- Modify: src/efficiency/policy.ts
- Test: src/decision/engine.test.ts
- Test: src/engines/decide-execution.test.ts
- Test: src/efficiency/policy.test.ts

Behavior:
- Hard gates still run first.
- Reusable exact results still run before new work.
- Fast-path is checked before delegation scoring.
- Delegation uses a deterministic minimum margin constant.
- Near-threshold delegation falls back to self-execution.
- The receipt explains the fast path and margin decision.

Do not change model routing, context selection, recovery, or synthesis in this task.

---

## Task 5: Attribution telemetry

Files:
- Modify: src/lifecycle/node-actor-manager.ts
- Modify: src/efficiency/metrics.ts
- Test: src/efficiency/metrics.test.ts

Add optional telemetry fields:
- fastPathTaken
- delegationMargin
- delegationRejectedByMargin

Record these through the existing decision/efficiency event path. Do not add duplicate storage just for metrics.

---

## Task 6: Verification and paid benchmark protocol

Local verification:
- npm run typecheck
- npm test
- npm run bench:deterministic

Paid benchmark:
- Fresh isolated worktree per goal.
- Randomize arm order.
- Use the same commit for matched arms.
- Add a hand-scored quality rubric.
- Primary metrics: cost/success, tokens/success, turns/success.
- Secondary metrics: p95 latency, success rate, delegation rate, fast-path rate, margin-rejection rate.

Focus cells:
- information-rich
- hard-budget
- strategy-failure
- tiny anchored edit
- medium single-unit task
- multi-workstream

Do not ship based on aggregate token movement alone. The benchmark report specifically calls out hard-budget and strategy-failure for mechanism-level tuning.

---

## Expected result

V1 should make three observable changes:
- Tiny concrete tasks take a direct route.
- Delegation needs meaningful economic surplus.
- Task-level resource consumption can later be enforced across the existing recursive hierarchy.

The key hypothesis is that preventing unnecessary work will improve the current regressions before additional context-compression machinery is introduced.