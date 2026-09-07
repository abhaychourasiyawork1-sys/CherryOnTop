# CherryOnTop Implementation Plan

**Companion to:** [Strategy v2](cherryontop-strategy-v2-2026-09-07.md)
**Date:** 7 September 2026
**Target:** solo developer / small team, local-first. No identity, RBAC, SSO, tenancy, or multi-user server anywhere in this plan.
**Ordering:** dependency order, not a calendar. Each phase is shippable on its own and each task names its files and its acceptance check.

---

## Ground rules for whoever executes this

1. **Reuse before writing.** [WhyPanel](gui/src/renderer/src/panels/WhyPanel.tsx), [OrgGraph](gui/src/renderer/src/graph/OrgGraph.tsx), [NodeCard](gui/src/renderer/src/graph/NodeCard.tsx), [Inspector](gui/src/renderer/src/panels/Inspector.tsx), [Conversation](gui/src/renderer/src/panels/Conversation.tsx), [LiveStatus](gui/src/renderer/src/panels/LiveStatus.tsx), [transcript.ts](gui/src/renderer/src/lib/transcript.ts), [markdown.ts](gui/src/renderer/src/lib/markdown.ts) all survive the reform. The shell changes; the components do not.
2. **No new runtime dependencies** unless a phase names one. The GUI's dependency list is 6 packages and should stay small.
3. **Every schema change is a drizzle migration**, generated not hand-written, following the existing `src/db/migrations/` convention.
4. **One runnable check per non-trivial task.** Vitest, colocated `*.test.ts`, matching what the repo already does.
5. **Nothing in P0 is optional.** P0 is the difference between the pitch being true and being a lie.

---

# Phase 0 — Make the claim true

Nothing in this phase is visible in a screenshot. All of it is the reason anyone would believe the screenshots.

## 0.1 Runs survive a daemon restart *(P0, largest single task)*

**Problem.** [node-actor-manager.ts:34](src/lifecycle/node-actor-manager.ts:34) keeps actors in daemon memory only. [orphans.ts:51](src/lifecycle/orphans.ts:51) marks every in-flight node dead on boot and tells the user to start over. [node.ts:126](src/server/routers/node.ts:126) then refuses any approval for those nodes. A restart destroys work *and* the pending human decision about that work.

**Approach.** Rehydrate from the event log we already keep — the upgrade path the code's own `ponytail:` marker already names. This is the durable-execution pattern (replay event history, do not re-ask the model for decisions already recorded), applied to the store we have rather than a new one.

- Add `src/lifecycle/rehydrate.ts`: read `events` for every non-terminal node, reconstruct actor state from the recorded machine transitions, and re-register with [node-actor-manager](src/lifecycle/node-actor-manager.ts).
- The K8s Job for a running node may still be alive: reattach by job name before assuming it died. [k8s/client.ts](src/k8s/client.ts) already knows the naming scheme.
- A node blocked on an approval rehydrates into the *blocked* state without re-running anything — this is the case that matters most and the easiest one, since there is no live process to recover.
- Reduce [orphans.ts](src/lifecycle/orphans.ts) to the genuinely unrecoverable case: a node whose Job is gone and whose last event was mid-execution. Give it a distinct state (`INTERRUPTED`, not `FAILED`) and make it resumable in 0.2.

**Acceptance.** Start a run → let it reach a budget escalation → `org daemon stop` → `org daemon start` → the approval is still in the Inbox, approving it resumes the node, and the run completes. A test in `src/lifecycle/rehydrate.test.ts` drives this against an in-memory DB with no daemon.

## 0.2 Resume and retry an interrupted node *(P0)*

Once 0.1 lands, an `INTERRUPTED` node can be re-dispatched from its last completed step. [execute-step.ts:127](src/execution/execute-step.ts:127) already tracks a resume offset — extend that from within-step to across-dispatch.

**Acceptance.** Kill the daemon mid-execution; on restart the node shows `Interrupted`, a Resume action re-dispatches it, and the event log shows one continuous node history rather than two runs.

## 0.3 Enforce `authority.tools` at the execution boundary *(P0 — this is the pitch)*

**Problem.** `authority.tools` is consulted only at [authority.ts:14](src/engines/authority.ts:14) when narrowing a child's grant. No check exists between a node's contract and the tools its sandbox actually uses. The product claims a tool authority boundary that does not exist.

**Approach.** Enforce at the adapter, where the tool call is observable, and record every check.

- In [src/adapters/](src/adapters/) (both the Claude Code and [codex.ts](src/adapters/codex.ts) adapters), pass the node's allowed tool list into the runtime's own permission mechanism where one exists, so denial happens *before* the call rather than after.
- Add `src/engines/enforce-tools.ts`: a single `checkTool(contract, toolName)` used by every adapter. One function, all callers — a guard in the shared path, not one per adapter.
- Emit an `authority.denied` event on refusal, carrying node, tool, and the mandate that denied it. This event is what the Proof view and the Receipt render.
- An empty `tools: []` currently means "no restriction" by accident. Make the semantics explicit: `[]` means *unrestricted*, and a new sentinel or an explicit list means *restricted*. Migrate the default mandate in 0.4 to a real list so the common path is the enforced path.

**Acceptance.** `src/engines/enforce-tools.test.ts` asserts allow/deny for a contract with an explicit list. End-to-end: a node granted `['Read']` that attempts a write produces an `authority.denied` event and does not write the file.

## 0.4 Make `constraints` mean something, or delete it *(P0)*

`contract.constraints` has zero consumers. Two honest options; pick one and do it fully:

- **Enforce:** treat each constraint as text injected into the adapter's system prompt *and* surfaced on the Receipt as "instructed, not enforced" — clearly labelled as a soft boundary, unlike tools and budget which are hard.
- **Delete:** remove the field, the schema entry, and its Inspector rendering.

**Recommendation: enforce, with honest labelling.** A soft constraint that is visibly marked soft is useful; one that silently does nothing is a liability the moment someone audits us. Never render a soft constraint in the same visual weight as an enforced one.

**Acceptance.** Either the constraint text appears in the dispatched prompt (assert in an adapter test) and renders with a "soft" marker, or `grep -rn constraints src/ gui/` returns nothing.

## 0.5 The Mandate becomes a real object *(P0)*

**Problem.** [App.tsx](gui/src/renderer/src/App.tsx) hardcodes `{ tools: [], spawn_children: true, max_child_count: 3, budget_usd: 5 }` on every task. The user cannot author the thing the product is about.

- New table `mandates` (id, name, contract JSON, createdAt, updatedAt) — one migration.
- New router `src/server/routers/mandate.ts`: list, get, create, update, delete. Register in [root-router.ts](src/server/root-router.ts).
- Seed three templates on first run: **Investigate** (read-only, no delegation, $1), **Focused change** (read/write/bash, no delegation, $5), **Project** (full tools, ≤5 children, $25).
- `nodes` gains `mandateId` and `mandateSnapshot` (the contract as it was at dispatch — a mandate edited later must not rewrite history).
- `node.create` accepts a `mandateId`.

**Acceptance.** Two runs started from different mandates show different authority in the Inspector, and editing a mandate afterwards does not change either run's recorded snapshot. Test in `src/db/queries/mandates.test.ts`.

## 0.6 The Authority Simulator *(P0, small)*

`src/engines/simulate-authority.ts`: pure function, contract in, human-readable envelope out. No model call, no execution, no I/O.

> *Up to 3 agents. Up to $5.00 total. May use Read, Write, Bash. No network. Stops and asks you if it needs more than $5.00 or a 4th agent.*

Used in three places: the composer's authority preview, the Mandates editor, and the Receipt header.

**Acceptance.** `simulate-authority.test.ts` — a table of contracts to expected sentences. Pure function, trivial to test, and it is the sentence the whole product is selling.

---

# Phase 1 — The reformed shell

Ships the visible product. Depends on P0 for its content to be true.

## 1.1 Rebuild the shell, keep the components

Replace [App.tsx](gui/src/renderer/src/App.tsx)'s `Rail + tab` model with a five-destination nav. New `gui/src/renderer/src/shell/Nav.tsx` and a small route state (`useState` on a union type is sufficient — do not add a router dependency for five destinations).

Destinations: **Desk · Cases · Case · Mandates · Memory**.
[Rail.tsx](gui/src/renderer/src/panels/Rail.tsx) is retired; its task list becomes Cases, its Inbox aside becomes Desk, its Memory aside becomes the Memory destination, its repo label moves to the shell header.

## 1.2 Desk — the attention queue

`gui/src/renderer/src/panels/Desk.tsx`. One ranked list merging five sources, not just approvals:

| Source | Signal |
|---|---|
| Pending approval | existing `approvals` rows |
| Over budget | `costUsd > authority.budget_usd` |
| Stalled | non-terminal, no event for N minutes (start with 5) |
| DoD unmet | terminal node with unmet definition-of-done items (needs 1.4) |
| Interrupted | the state added in 0.1 |

Ranking is a plain scoring function in `gui/src/renderer/src/lib/attention.ts` — a sort key, not an engine.
Reuses [Inbox](gui/src/renderer/src/panels/Inbox.tsx)'s expand-and-resolve row wholesale for the approval case, and [LiveStatus](gui/src/renderer/src/panels/LiveStatus.tsx) below the fold for live runs. Empty queue → the Hero composer.

**Acceptance.** `attention.test.ts` asserts ordering across all five sources. A node over budget appears on Desk without a human opening its task.

## 1.3 Cases — the run list that does not exist today

`gui/src/renderer/src/panels/Cases.tsx` + `src/server/routers/case.ts` (`list` with filters, server-side).
Filters: state, mandate, repository, runtime, date range, cost range, DoD met, human intervened. Columns: goal, state, agents, cost/budget, duration, outcome. Text search over goal.

**Acceptance.** 50 seeded runs filter to the right subset; query test in `src/db/queries/cases.test.ts`. This is the biggest single usability win in the plan.

## 1.4 Verified Definition of Done

New table `dod_items` (id, nodeId, text, state `met|unmet|unverified`, evidenceArtifactId, evidenceEventId, checkedAt) — populated from `contract.definition_of_done` at node creation.
Closing a commitment resolves items against recorded evidence rather than flipping a status. Rendered as a checklist with evidence links in the Case header and the Inspector Overview, replacing today's plain `<ul>` at [Inspector.tsx Overview](gui/src/renderer/src/panels/Inspector.tsx).

**Acceptance.** A completed run shows each DoD item green with a clickable artifact, or amber-unverified — never a bare status word.

## 1.5 The Case File header

`gui/src/renderer/src/panels/CaseHeader.tsx`. Above every view, answering the stakeholder question without a transcript: objective · mandate (name + simulated envelope) · state · cost against ceiling · DoD progress · artifacts produced · what needs you.

## 1.6 Chain of Custody strip

`gui/src/renderer/src/panels/Custody.tsx`. `you → root(goal) → …→ node(goal) → tool`, each hop showing what was granted and what was narrowed. Data is already in `nodes.parentId` + `contract.authority`; the narrowing test already exists as `narrowedAuthority` in [OrgGraph.tsx](gui/src/renderer/src/graph/OrgGraph.tsx) — lift it to `gui/src/renderer/src/lib/custody.ts` and reuse in both places rather than duplicating.

Appears on: every artifact row, every decision, every approval, and the Receipt.

**Acceptance.** `custody.test.ts` builds the chain for a 3-deep tree and marks the correct hop as narrowed.

## 1.7 The Receipt

`gui/src/renderer/src/panels/Receipt.tsx` — a compact, printable object per case: objective · mandate + envelope · chain of custody · decisions with economics breakdowns (reuse [WhyPanel](gui/src/renderer/src/panels/WhyPanel.tsx) unchanged) · DoD verification · artifacts · approvals with human and timestamp · cost and duration · hash-chain footer (from 2.3).

**Export as one self-contained HTML file** via a main-process handler in [gui/src/main/index.ts](gui/src/main/index.ts) — no server, no auth, no URL. Attachable to a PR or a ticket.

**Acceptance.** Export a completed case, open the file in a browser with the network off, and every section renders.

## 1.8 Counterfactual "why not"

Extend [WhyPanel](gui/src/renderer/src/panels/WhyPanel.tsx) with one line derived from the existing breakdown: which single term, and by how much, would have flipped the outcome. Pure arithmetic over data already rendered.

> *Delegating scored +0.42 against a threshold of +0.30. Had verification cost been $0.13 higher, it would have done the work itself.*

**Acceptance.** `whypanel.test.ts` (new) asserts the flip term and margin for a known breakdown. Keep the existing fall-through-unknown-terms behaviour — do not regress it.

## 1.9 Authority preview on the composer

One line under [Composer](gui/src/renderer/src/panels/Composer.tsx) rendering `simulateAuthority(selectedMandate)` plus a mandate picker. Nobody else in this market shows the blast radius before you press go.

## 1.10 Mandates destination

`gui/src/renderer/src/panels/Mandates.tsx`. Form-first list/create/edit/duplicate/delete, live simulator output as you type, and a diff between two mandates. **No canvas** — see the OpenAI Agent Builder retirement in the strategy doc.

---

# Phase 2 — Depth

## 2.1 Time-travel over the organization

A scrubber above [OrgGraph](gui/src/renderer/src/graph/OrgGraph.tsx) that filters `nodes`/`approvals`/`costUsd` to a timestamp derived from `events`. Everything needed is already streamed into the renderer by [useOrg.ts](gui/src/renderer/src/lib/useOrg.ts); the graph itself needs no change beyond receiving a filtered prop. New `gui/src/renderer/src/lib/timetravel.ts` does the projection.

**Acceptance.** `timetravel.test.ts` projects a known event sequence to three timestamps and asserts node count, states, and spend at each.
*This is the demo shot. It is also one of the cheapest tasks in the plan, because the data model was already right.*

## 2.2 Cost rollups and burn treemap

Router: per-case totals, per-branch attribution, per-runtime and per-mandate cost/duration over time. GUI: a treemap over the org tree showing which branch consumed the budget, plus a trend on Cases.
Reuse [stats.ts](src/db/queries/stats.ts) rather than adding a parallel aggregation path.

## 2.3 Tamper-evident event log

Add `events.prevHash` and `events.hash` (one migration). Each insert hashes `(prevHash, nodeId, type, payload, createdAt)` with `node:crypto` — no dependency. Add `org verify` to the CLI to walk the chain and report the first break.
Receipt renders the head hash and a verified/broken marker.

**Acceptance.** `events.test.ts` — an unbroken chain verifies; a hand-edited payload row fails verification at exactly that row.
**Language discipline:** *tamper-evident*, never *tamper-proof*, in code comments, UI, and copy.

## 2.4 Memory with provenance and veto

Rebuild [Memory.tsx](gui/src/renderer/src/panels/Memory.tsx) as claims with evidence: statement, sample size, confidence, drill-down to the contributing runs, and a veto that excludes a row from `getRuntimeStats` calibration. Add authored notes scoped to a repository — our answer to Devin Knowledge and OpenHands microagents, except ours arrive with an *n*.

**Acceptance.** Vetoing a `run_outcome` row changes the next runtime-selection decision's breakdown. That is the check that proves memory is wired to behaviour and not decoration.

## 2.5 Git surface

Today artifacts are paths and summaries; the runtime dispatches Claude Code, which offers richer git handling than we expose. Minimum viable:
- Capture the diff per node and render it in the Evidence tab using the existing diff rendering already present in [Inspector](gui/src/renderer/src/panels/Inspector.tsx)'s ActivityTab.
- Run each task in its own git worktree — the same pattern Claude Code uses for parallel sessions, and the honest local answer to "parallel agents" without building a scheduler.
- Per-case branch name in the Case header.

Defer PR creation and auto-merge.

## 2.6 Replay and fork

`node.replay({ nodeId, mandateId?, runtime? })` — re-dispatch a completed node under a changed mandate, linking the new run to the original. Case view gains a two-column diff: cost, duration, DoD met, artifacts, decision breakdowns.

**Acceptance.** Fork a completed case onto a smaller budget and see the two outcomes side by side with the numeric decision delta.

## 2.7 MCP client

Add MCP tool support to the adapters, with each MCP tool named in `authority.tools` and therefore enforced by 0.3 for free. **Client only — no registry, no marketplace, no catalog UI.** The point is interop with the ecosystem, not a connector business.

**Acceptance.** A node granted one MCP tool can call it; a node not granted it produces `authority.denied`.

## 2.8 OpenTelemetry spans

Emit OTEL spans at dispatch, decision, tool call, and approval boundaries. Small diff, and it is the vocabulary the market now expects — AgentCore made OTEL-compatibility the default expectation and every observability vendor consumes it.

---

# Phase 3 — Deferred, in order

Reassess only after Phase 2 ships and there is usage evidence.

1. Scheduling and headless API trigger (OpenHands-style REST submission).
2. Evaluation datasets, annotations, scorecards — meaningless before a corpus of runs exists.
3. Slack/Teams approval actions and notifications.
4. Mandate versioning with promotion gates.
5. Identity, RBAC, SSO, workspaces, Postgres, multi-tenancy — **only** on a confirmed team/enterprise buyer. When it comes, bind the existing delegation chain to an external identity (Entra Agent ID or SPIFFE) rather than inventing our own.

---

# Ordering summary

| Phase | Tasks | Unlocks |
|---|---|---|
| **0** | 0.1 durability · 0.2 resume · 0.3 tool enforcement · 0.4 constraints · 0.5 mandates · 0.6 simulator | The pitch becomes true. Trials stop dying on restart. |
| **1** | 1.1 shell · 1.2 Desk · 1.3 Cases · 1.4 DoD · 1.5 Case header · 1.6 custody · 1.7 Receipt · 1.8 counterfactual · 1.9 preview · 1.10 Mandates | The product is demoable and the marketing is literal. |
| **2** | 2.1 time-travel · 2.2 cost · 2.3 hash chain · 2.4 memory · 2.5 git · 2.6 replay · 2.7 MCP · 2.8 OTEL | Depth, defensibility, and the launch video. |
| **3** | scheduling, evals, chat, versioning, identity | Only on evidence. |

**If only one thing ships: 0.1.** A pending approval that does not survive a daemon restart is the defect that ends a trial, and it undermines the one claim the whole product rests on.
