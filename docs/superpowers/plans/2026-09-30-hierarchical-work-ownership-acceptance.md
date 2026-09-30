# Hierarchical Work Ownership & Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace delegation's fresh-child retry and eager fork integration with a durable parent-child ownership contract, parent acceptance gate, and same-child feedback/rework loop.

**Architecture:** Add one focused delegation record/schema/query layer for assignment state, then adapt the existing delegation runtime so a child reaches `REPORT_READY`, the parent validates the candidate worktree against explicit acceptance checks, and only an accepted result merges. Keep the current node state machine, authority/budget engines, workstream scheduler, evidence/recovery system, and Action Market as the existing primitives; do not create a second orchestration architecture.

**Tech Stack:** TypeScript, Zod, Drizzle/SQLite, XState 5, Vitest, existing workspace-fork and validation/evidence modules.

**Spec:** `docs/architecture/hierarchical-work-ownership-acceptance.md`

## Global Constraints

- Preserve recursive hierarchical delegation as the core organizational abstraction.
- Do not merge child changes before parent acceptance passes.
- Normal acceptance failure must reuse the same child/worktree; fresh child creation is exceptional.
- Parent acceptance checks must be durable and auditable.
- Do not create a second competing node lifecycle state machine.
- Keep authority and budget bounded by the existing authority/commitment mechanisms.
- Do not resend full parent transcripts; use the existing envelope/context-reference approach.
- Economic decisions may optimize actions/resources but may not bypass hard validation/acceptance constraints.
- Existing isolation behavior for concurrent write-capable siblings must remain intact.
- Use TDD and run the narrowest relevant Vitest suite after each task.

## Review Focus

1. **Child reports success with no parent acceptance evidence** — it must remain `REPORT_READY`, never merge.
   - Test in Task 4: report-ready child with failing/absent acceptance evidence remains isolated.

2. **Acceptance fails after a child has already changed files** — the same child must receive feedback and retain its worktree/context.
   - Test in Task 5: failed review emits feedback and the next rework starts on the same child ID and fork.

3. **A parent has multiple siblings with overlapping writes** — no accepted child may silently clobber another accepted child's work.
   - Test in Task 6: acceptance/integration remains serialized/conflict-aware.

4. **A child is cancelled or its parent stops during review/rework** — cancellation must not trigger automatic reassignment.
   - Test in Task 5: cancelled child stays cancelled and no replacement is created.

5. **A reassignment happens for a real exceptional reason** — it must be explicit, auditable, and not look like an ordinary retry.
   - Test in Task 5: reassignment increments assignment lineage only through an explicit action/reason.

---

### Task 1: Add the durable delegation contract

**Files:**
- Create: `src/schemas/delegation.ts`
- Modify: `src/db/schema.ts`
- Create: `src/db/queries/delegations.ts`
- Create: `src/db/migrations/<next>_hierarchical_delegation.sql`
- Test: `src/db/queries/delegations.test.ts`

**Interfaces:**
- Consumes: existing `NodeContract`, child authority, existing event log.
- Produces: `DelegationStatus`, `DelegationRecord`, `createDelegation`, `getDelegation`, `updateDelegation`, `listDelegationsForParent`, `listDelegationsForChild`.

- [ ] **Step 1: Write failing schema/query tests**

Test:
- creates one assignment with parent/child IDs, DoD, acceptance checks, dependency list, revision, attempt, budget, and `ASSIGNED` status;
- returns the latest row by assignment ID;
- updates status/revision atomically;
- preserves report/feedback JSON snapshots when present;
- rejects invalid status values through Zod before persistence.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npx vitest run src/db/queries/delegations.test.ts -v`
Expected: FAIL because the new schema/query module does not exist.

- [ ] **Step 3: Implement `DelegationStatus` and `DelegationRecord` in `src/schemas/delegation.ts`**

Use the core statuses from the spec. Keep `ASSIGNED`, `WORKING`, `REPORT_READY`, `UNDER_REVIEW`, `ACCEPTED`, `MERGING`, `MERGED`, `FEEDBACK_REQUIRED`, `REWORKING`, `BLOCKED`, `ESCALATED`, `REASSIGNED`, `CANCELLED`, `INTEGRATION_BLOCKED`.

- [ ] **Step 4: Add the SQLite table and migration**

Add a `delegations` table with columns for `id`, `parent_id`, `child_id`, `data`, `status`, `revision`, `attempt`, `created_at`, `updated_at`, plus indexes on parent and child. Keep the full assignment/report/feedback structure in typed JSON so this slice does not introduce a wide relational schema.

- [ ] **Step 5: Implement the query functions**

`createDelegation(db, record)` inserts revision 1 and attempt 1.

`updateDelegation(db, id, patch)` reads the current revision and writes revision + 1 in one transaction; stale/missing IDs must fail deterministically.

`getDelegation`, `listDelegationsForParent`, and `listDelegationsForChild` return typed records.

- [ ] **Step 6: Run the focused tests**

Run: `npx vitest run src/db/queries/delegations.test.ts -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/schemas/delegation.ts src/db/schema.ts src/db/queries/delegations.ts src/db/migrations/*_hierarchical_delegation.sql src/db/queries/delegations.test.ts
git commit -m "feat: add durable hierarchical delegation records"
```

---

### Task 2: Make assignment creation carry child DoD and parent acceptance checks

**Files:**
- Modify: `src/lifecycle/delegate-child.ts`
- Modify: `src/lifecycle/node-actor-manager.ts`
- Modify: `src/schemas/node-contract.ts`
- Modify: `src/db/queries/dod.ts` only if needed to record child DoD items
- Test: `src/lifecycle/delegate-child.test.ts`
- Test: `src/lifecycle/node-actor-manager.fork-isolation.test.ts`

**Interfaces:**
- Consumes: Task 1 `DelegationRecord` and persistence functions.
- Produces: `DelegateInput.acceptanceChecks?: string[]`, `DelegateInput.definitionOfDoneBySubgoal?: string[][]`, and a real delegation creation call that records the contract before `startChild`.

- [ ] **Step 1: Write failing delegation tests**

Add tests asserting:
- each child gets its own DoD rather than `[goal]` by default when explicit DoD exists;
- parent acceptance checks are stored on the child assignment;
- assignment is created before `startChild`;
- the child envelope contains the assignment's acceptance contract in compact form;
- missing acceptance checks is allowed only when the caller intentionally chooses zero extra parent checks, not because the data was silently dropped.

- [ ] **Step 2: Run the focused tests to verify failure**

Run: `npx vitest run src/lifecycle/delegate-child.test.ts src/lifecycle/node-actor-manager.fork-isolation.test.ts -v`
Expected: new assertions FAIL.

- [ ] **Step 3: Extend `DelegateInput`**

Add optional per-subgoal DoD and parent acceptance checks. Preserve backwards compatibility by deriving a minimal DoD from the subgoal only when the caller provides no richer contract.

- [ ] **Step 4: Create the delegation record in `realDelegateDeps.createChildNode`**

Create the node and the delegation record as one logical operation. Store the child's authority/budget snapshot from the already-computed child contract rather than recomputing it later.

- [ ] **Step 5: Build the child envelope from the assignment contract**

Use `buildAgentEnvelope`/existing envelope storage. Include the compact DoD, acceptance checks, constraints, relevant context refs, and budget. Do not paste parent transcript content.

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/lifecycle/delegate-child.test.ts src/lifecycle/node-actor-manager.fork-isolation.test.ts -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lifecycle/delegate-child.ts src/lifecycle/node-actor-manager.ts src/schemas/node-contract.ts src/lifecycle/delegate-child.test.ts src/lifecycle/node-actor-manager.fork-isolation.test.ts src/db/queries/dod.ts
git commit -m "feat: persist delegation contracts and acceptance checks"
```

---

### Task 3: Add structured child report and parent feedback contracts

**Files:**
- Modify: `src/intelligence/synthesize.ts`
- Modify: `src/intelligence/result-envelope.ts` only where the existing result envelope can carry structured report fields without breaking its parser
- Create: `src/lifecycle/delegation-reports.ts`
- Test: `src/lifecycle/delegation-reports.test.ts`
- Modify: `src/prompts/roles.ts` only if the execute prompt needs a compact reporting instruction

**Interfaces:**
- Consumes: existing `AgentResultEnvelope`, `ChildReport`, evidence/artifact references.
- Produces: `ChildDelegationReport`, `ParentFeedback`, `buildParentFeedback`, `compactReworkContext`.

- [ ] **Step 1: Write failing tests**

Test:
- child report parsing extracts changed files, tests, evidence refs, blockers and remaining work;
- malformed/oversized report degrades to a bounded fallback rather than breaking the parent;
- parent feedback contains only failed checks, observed/expected behavior, evidence refs, required changes and next checks;
- rework context is bounded and does not contain the parent's raw transcript.

- [ ] **Step 2: Run the focused test**

Run: `npx vitest run src/lifecycle/delegation-reports.test.ts -v`
Expected: FAIL.

- [ ] **Step 3: Implement report/feedback types and pure builders**

Reuse the existing result-envelope parser. Do not create a second child-result format when the existing envelope can supply the fields.

- [ ] **Step 4: Implement `compactReworkContext`**

Prefer references and clipped diagnostic facts. Use a fixed maximum much smaller than a raw transcript, consistent with the existing `MAX_REPORT_CHARS` discipline.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/lifecycle/delegation-reports.test.ts -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lifecycle/delegation-reports.ts src/lifecycle/delegation-reports.test.ts src/intelligence/synthesize.ts src/intelligence/result-envelope.ts src/prompts/roles.ts
git commit -m "feat: add structured delegation reports and feedback"
```

---

### Task 4: Replace eager completion/merge with parent review

**Files:**
- Modify: `src/lifecycle/delegate-child.ts`
- Modify: `src/lifecycle/node-actor-manager.ts`
- Modify: `src/validation/delegated.ts`
- Test: `src/lifecycle/delegate-child.test.ts`
- Test: `src/lifecycle/node-actor-manager.fork-isolation.test.ts`
- Test: `src/validation/delegated.test.ts`

**Interfaces:**
- Consumes: Task 1 assignment records, Task 3 child reports, existing `validateDelegatedOutcome`.
- Produces: `waitForChildReport`, `reviewDelegation`, and a `waitForChild` result that does not imply merge success.

- [ ] **Step 1: Write failing tests**

Test:
- a child that exits successfully but fails parent acceptance remains `REPORT_READY`/not accepted;
- `waitForChild` does not call `settleFork` merely because the node finished;
- a failed acceptance keeps the fork on disk;
- a passing acceptance transitions to `ACCEPTED` and only then permits merge;
- parent required checks are evaluated in addition to the child's own validation.

- [ ] **Step 2: Run focused suites**

Run:
`npx vitest run src/lifecycle/delegate-child.test.ts src/lifecycle/node-actor-manager.fork-isolation.test.ts src/validation/delegated.test.ts -v`
Expected: new tests fail, and the old "failed child still integrates" test identifies the behavior that must change.

- [ ] **Step 3: Separate "child finished" from "assignment accepted"**

Change the dependency contract so completion returns the child's report/validation state while leaving fork ownership with the delegation runtime until the parent review resolves it.

- [ ] **Step 4: Implement parent review**

Build a review function that:
1. loads the assignment;
2. loads the child report/evidence;
3. creates the parent-side validation evidence;
4. evaluates explicit acceptance checks through the existing validation/delegated-validation path;
5. records `UNDER_REVIEW` then `ACCEPTED` or `FEEDBACK_REQUIRED`.

The implementation may choose a more efficient existing validation hook where available, but it must not mark acceptance without evidence for every required check.

- [ ] **Step 5: Keep the fork on failed review**

Do not release or integrate the fork on `FEEDBACK_REQUIRED`. The same child and fork remain the rework target.

- [ ] **Step 6: Run focused suites**

Expected: PASS for the new ownership/acceptance behavior.

- [ ] **Step 7: Commit**

```bash
git add src/lifecycle/delegate-child.ts src/lifecycle/node-actor-manager.ts src/validation/delegated.ts src/lifecycle/delegate-child.test.ts src/lifecycle/node-actor-manager.fork-isolation.test.ts src/validation/delegated.test.ts
git commit -m "feat: gate child integration on parent acceptance"
```

---

### Task 5: Implement same-child feedback/rework and exceptional reassignment

**Files:**
- Modify: `src/lifecycle/delegate-child.ts`
- Modify: `src/lifecycle/node-actor-manager.ts`
- Modify: `src/recovery/types.ts` only if a small linkage field is needed
- Create or modify: `src/lifecycle/delegation-rework.test.ts`
- Test: `src/lifecycle/delegate-child.test.ts`

**Interfaces:**
- Consumes: Task 1 assignment record, Task 3 feedback builder, Task 4 review result.
- Produces: `requestRework(assignmentId, feedback)`, `requestReassignment(assignmentId, reason)`, and assignment revision/attempt bookkeeping.

- [ ] **Step 1: Write failing tests**

Test:
- failed acceptance emits feedback to the same child;
- the same child ID is restarted/re-entered for rework;
- the same fork path is retained;
- revision increases while assignment ID and child ID remain unchanged;
- previous report and failure evidence are available to the next child dispatch;
- cancellation causes no replacement;
- reassignment requires explicit reason and changes child ownership only then.

- [ ] **Step 2: Run focused tests**

Run: `npx vitest run src/lifecycle/delegation-rework.test.ts src/lifecycle/delegate-child.test.ts -v`
Expected: FAIL against the current fresh-sibling replacement behavior.

- [ ] **Step 3: Replace `replaceFailedChild` as the default recovery**

Delete the ordinary fresh-child loop. For acceptance failures, persist `FEEDBACK_REQUIRED`, build compact rework context, update the assignment revision, move to `REWORKING`, and start the same child again.

Do not delete the underlying child row or create a new worktree.

- [ ] **Step 4: Preserve recovery evidence**

Record the failed check/evidence in the assignment and existing recovery/event mechanisms so repeated failure remains diagnosable.

- [ ] **Step 5: Add explicit reassignment path**

Create a separate function/action for exceptional reassignment. It must record:
- old child;
- new child;
- reason;
- triggering evidence;
- decision/authorization reference where required.

The normal validation failure path must never call it automatically.

- [ ] **Step 6: Re-run focused tests**

Expected: PASS. Specifically assert the old test expectation "failed piece gets a fresh sibling" is intentionally replaced by same-child rework.

- [ ] **Step 7: Commit**

```bash
git add src/lifecycle/delegate-child.ts src/lifecycle/node-actor-manager.ts src/recovery/types.ts src/lifecycle/delegation-rework.test.ts src/lifecycle/delegate-child.test.ts
git commit -m "feat: rework delegated tasks with the same child"
```

---

### Task 6: Make merge an explicit accepted-only transition

**Files:**
- Modify: `src/lifecycle/node-actor-manager.ts`
- Modify: `src/execution/workspace-fork.ts` only if a small retain/release capability is necessary
- Create: `src/lifecycle/delegation-merge.test.ts`
- Test: `src/lifecycle/node-actor-manager.fork-isolation.test.ts`

**Interfaces:**
- Consumes: Task 4 accepted delegation status and existing `integrateFork(fork)`.
- Produces: `mergeAcceptedDelegation(assignmentId)`.

- [ ] **Step 1: Write failing tests**

Test:
- only `ACCEPTED` may enter `MERGING`;
- successful integration produces `MERGED`;
- failed integration produces `INTEGRATION_BLOCKED`, does not mark the child successful, and retains evidence/fork as appropriate;
- a child that has not been reviewed cannot merge even if its execution state is `COMPLETE`.

- [ ] **Step 2: Run focused tests**

Run: `npx vitest run src/lifecycle/delegation-merge.test.ts src/lifecycle/node-actor-manager.fork-isolation.test.ts -v`
Expected: FAIL until `settleFork` and its callers are changed.

- [ ] **Step 3: Change `settleFork` semantics**

Refactor it so it is no longer a generic "child finished" integration path. Either:
- make it operate only on an accepted assignment, or
- introduce `mergeAcceptedDelegation` and make `settleFork` a low-level merge helper.

Prefer the second if it reduces compatibility risk: the helper remains mechanical, while the lifecycle gate becomes explicit.

- [ ] **Step 4: Keep failed/unaccepted forks alive**

Do not release failed review forks. Release only after successful merge, cancellation, or another explicit terminal cleanup path.

- [ ] **Step 5: Run tests**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lifecycle/node-actor-manager.ts src/execution/workspace-fork.ts src/lifecycle/delegation-merge.test.ts src/lifecycle/node-actor-manager.fork-isolation.test.ts
git commit -m "feat: make delegation merge acceptance-gated"
```

---

### Task 7: Add durable relationship events and event-driven projection

**Files:**
- Modify: `src/db/queries/events.ts` only for typed helpers if useful
- Create: `src/lifecycle/delegation-events.ts`
- Modify: `src/lifecycle/node-actor-manager.ts`
- Modify: `src/lifecycle/delegate-child.ts`
- Test: `src/lifecycle/delegation-events.test.ts`

**Interfaces:**
- Consumes: Task 1 delegation records and Task 5/6 lifecycle transitions.
- Produces: typed event names/payloads and `recordDelegationEvent`.

- [ ] **Step 1: Write failing tests**

Assert events are written for:
`ASSIGNED`, `REPORT_READY`, `UNDER_REVIEW`, `ACCEPTED`, `FEEDBACK_REQUIRED`, `REWORKING`, `MERGING`, `MERGED`, and `REASSIGNED`.

Also assert event payloads include assignment ID, parent ID, child ID, revision, and the minimal evidence/reason needed to reconstruct the transition.

- [ ] **Step 2: Run focused test**

Run: `npx vitest run src/lifecycle/delegation-events.test.ts -v`
Expected: FAIL.

- [ ] **Step 3: Implement typed delegation events**

Use the existing tamper-evident `appendEvent` path. Do not create another event store.

- [ ] **Step 4: Emit events at transition boundaries**

Do not emit duplicate events from both business logic and projection code. The operation that successfully changes the assignment status owns the event.

- [ ] **Step 5: Run focused tests**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/queries/events.ts src/lifecycle/delegation-events.ts src/lifecycle/node-actor-manager.ts src/lifecycle/delegate-child.ts src/lifecycle/delegation-events.test.ts
git commit -m "feat: audit hierarchical delegation lifecycle"
```

---

### Task 8: Rework scheduling/recovery integration and remove obsolete retry semantics

**Files:**
- Modify: `src/lifecycle/delegate-child.ts`
- Modify: `src/lifecycle/node-actor-manager.ts`
- Modify: `src/validation/delegated.ts`
- Modify: `src/recovery/engine.ts` only if the same-child loop needs a distinct signature/action
- Test: `src/lifecycle/control-loop.integration.test.ts`
- Test: `src/lifecycle/delegate-child.test.ts`

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces: final delegation control-loop behavior compatible with workstream scheduling and Action Market decisions.

- [ ] **Step 1: Write integration tests for a complete lifecycle**

Test these paths end-to-end with test doubles:
1. assign → child success → parent checks pass → merge;
2. assign → child report → parent check fails → feedback → same child rework → pass → merge;
3. sibling A passes while sibling B fails → A is retained; only B reworks;
4. dependency child fails → dependent remains blocked rather than being falsely marked failed;
5. exceptional reassignment occurs only through an explicit action;
6. parent cancellation stops future child creation and does not replace cancelled work.

- [ ] **Step 2: Run the integration test before changing remaining code**

Run: `npx vitest run src/lifecycle/control-loop.integration.test.ts -v`
Expected: new lifecycle assertions fail.

- [ ] **Step 3: Integrate with existing scheduling**

Keep `planWorkstreams` ordering/parallelism unchanged. The scheduling layer decides when child work may start; the new assignment lifecycle decides when completed child work may be accepted/merged.

- [ ] **Step 4: Integrate with economic decisions**

Do not add a second cost optimizer. Feed rework/reassignment/validation actions into the existing market where an action decision is already required. Assignment acceptance remains a hard constraint.

- [ ] **Step 5: Remove obsolete fresh-child retry code**

Delete `MAX_CHILD_ATTEMPTS`, `continuationGoal`, and `markSuperseded` usage from the ordinary delegation failure path once the explicit reassignment path is covering the exceptional case.

Retain node-level `supersededBy` only for explicit reassignment/replacement lineage that still needs the existing audit semantics.

- [ ] **Step 6: Run the complete relevant unit suite**

Run:
```bash
npm run typecheck
npx vitest run src/lifecycle src/validation src/db/queries -v
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lifecycle src/validation src/recovery
git commit -m "feat: complete hierarchical ownership acceptance loop"
```

---

### Task 9: Documentation, invariants, and regression benchmark

**Files:**
- Create: `docs/architecture/hierarchical-work-ownership-acceptance.md`
- Modify: `docs/architecture/implementation-audit.md`
- Modify: `docs/benchmarks/BENCHMARK-PROMPT.md` only if a new delegation benchmark fixture is appropriate
- Create: `src/lifecycle/delegation-invariants.test.ts`

**Interfaces:**
- Consumes: final implementation from Tasks 1–8.
- Produces: documented invariants and measurable regression protection.

- [ ] **Step 1: Write invariant tests**

Cover:
- no pre-acceptance merge;
- same-child rework;
- isolated failed worktree;
- explicit reassignment only;
- budget/authority unchanged by rework;
- evidence retained across revisions;
- recursive parent/child assignments remain valid.

- [ ] **Step 2: Run the invariant tests**

Run: `npx vitest run src/lifecycle/delegation-invariants.test.ts -v`
Expected: PASS.

- [ ] **Step 3: Update the architecture audit**

Mark the old delegation gaps closed and describe the new assignment/report/acceptance relationship, without claiming broader performance improvement until measured.

- [ ] **Step 4: Run build and relevant suites**

Run:
```bash
npm run build
npm run test:unit
```
Expected: PASS.

- [ ] **Step 5: Run a small before/after delegation benchmark**

Measure at minimum:
- successful tasks;
- total child dispatches;
- rework dispatches;
- reassignment count;
- merges;
- rejected merges;
- cost;
- turns;
- wall time;
- correctness.

Do not optimize for raw child count alone: the goal is correct completed work at lower information-acquisition and coordination cost.

- [ ] **Step 6: Commit**

```bash
git add docs/architecture/implementation-audit.md docs/benchmarks/BENCHMARK-PROMPT.md src/lifecycle/delegation-invariants.test.ts
git commit -m "docs: codify hierarchical delegation invariants"
```

---

## Final verification

Before declaring the feature complete:

```bash
npm run typecheck
npm run build
npm run test:unit
```

Then inspect the event log for one successful lifecycle and one rework lifecycle:

```
ASSIGNED
→ WORKING
→ REPORT_READY
→ UNDER_REVIEW
→ FEEDBACK_REQUIRED
→ REWORKING
→ REPORT_READY
→ UNDER_REVIEW
→ ACCEPTED
→ MERGING
→ MERGED
```

A fresh child appearing in the second lifecycle is a regression unless the event stream explicitly shows an exceptional reassignment decision.

## Implementation-agent freedom

The implementer may improve:
- exact helper/module boundaries;
- whether the acceptance runner uses an existing validation hook or a small adapter around it;
- exact JSON serialization shape;
- event payload compression;
- whether one or more helpers are colocated instead of split into additional files.

The implementer must not change:
- child execution ownership;
- parent acceptance ownership;
- acceptance-before-merge;
- same-child rework as the default;
- exceptional reassignment semantics;
- dynamic recursive hierarchy;
- existing authority/budget hard boundaries.
