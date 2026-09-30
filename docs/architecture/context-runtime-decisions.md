# Context runtime — decisions, deviations, limits

**Branch:** `feat/economic-action-market`. **Inputs:** the Context Runtime spec, its implementation plan,
and the issue/impact table. **Measured by:** `npm run bench:context`
([results](../benchmarks/2026-09-30-context-runtime-deterministic.md)) and the unit suite.

This records what was built, what was changed from the plan and why, and what was not built and why.
The plan said it was a guide, not a command; where the repository disagreed with it, the repository won
and the evidence is here.

## The one fact everything else follows from

CherryOnTop does not own a model context window. A dispatch is an agent CLI running inside a Kubernetes
Job; what CherryOnTop hands it is **one argv** — a system-prompt argument and a prompt argument — and what
it gets back is a stream of events it can read but not edit. This was established on 2026-09-12 (see
[the runtime-architecture ADR](../superpowers/architecture-decision-records/2026-09-12-runtime-architecture-critique.md),
Finding 1) and is still true: `RuntimeAdapter.buildCommand(goal, grant, opts)` takes one string.

The spec's flow, `manifest → retrieve → materialize → retain → prune → compact → PromptIR → compile → agent`,
therefore has two halves with different reach:

| half | reach | what was done |
|---|---|---|
| everything **before** the argv exists (select, materialize, hand off, compile) | fully ours | built |
| everything **after** the agent starts (prune, compact its live history) | the CLI's, not ours | **measured, not managed** — see D1 |

What the loop costs, from the repo's own data
([token/turn review](../superpowers/2026-09-26-token-and-turn-review.md)): ~55% re-reading context each
turn, ~22% cache writes, ~20% output; tool output over 8k characters is "under 1% of cost". The lever that
exists is the size and stability of what is handed over, and whether it can be handed over at all.

## Invariants: where each is enforced

| # | invariant | mechanism | test |
|---|---|---|---|
| I1 | one canonical owner | manifest holds *membership only* (D3); prompt, receipt, working set are projections | `task-context-manifest.test.ts` "stores references only" |
| I2 | prompt boundedness | one compile, two units, verified on the returned bytes (D2) | `adversarial.test.ts` (1,000 random documents) |
| I3 | recoverability | large output stays in `events`, reference points at the *output* event (bug fixed, D13) | `adversarial.test.ts` "still there when it is needed later" |
| I4 | revision safety | revision is part of a ref's identity; boundary refuses a request from another commit | `working-set.test.ts`, `evidence-actions.test.ts` "revision safety" |
| I5 | scope safety | `scopePermits` on every projection; scope digest in the ref identity | `working-set.test.ts` "what must not be shared" |
| I6 | economic justification | no model call added anywhere; every acquisition is priced by the existing economics | (no new `askModel`/dispatch on any path) |
| I7 | provider isolation | core is provider-neutral; capability state keyed by provider/model/account | `model-capability.test.ts` |
| I8 | determinism | compile, layout, quantiles, working-set projection are pure/ordered | `prompt-compiler.test.ts` "is deterministic" |
| I9 | graceful degradation | see the fallback table below | per row |
| I10 | observability without duplication | ledger stores counts and refs, clips free text | `context-ledger.test.ts` |

### Degradation, since there are no feature flags

The owner's instruction was that nothing ships behind a flag or in shadow mode: everything is live.
Reversibility is therefore by **fallback path**, each tested:

| optimization | if it fails | lands on |
|---|---|---|
| prompt compiler throws | `compileWithFallback` | plain layout-order concatenation, unbounded (the pre-compiler prompt) |
| a required block cannot fit | compile refused | dispatch not sent, market commitment released, reason recorded (never a truncated goal) |
| working set unreadable/unwritable | `projectWorkingSet`/`recordWorkingSet` guarded | selection with no sharing |
| manifest update fails | `recordRunInManifest`/`recordChildFinding` guarded | run proceeds unrecorded |
| symbol cannot be delimited | `findSymbolBody` → `null` | whole file if it still pays at its own price, else nothing |
| capability block would empty the market | soft refusal set aside | the runtime's own model-fallback path decides |
| cost model has < 5 samples | `estimateQuantiles` → `null` | the static priors that existed before |
| ledger sink throws | `flush` guarded | dispatch unaffected |

## Requirement map

| spec | status | where |
|---|---|---|
| F1 Task Context Manifest | **built**, narrowed (D3) | `src/context/runtime/{manifest-types,task-context-manifest}.ts` |
| F2 Retention / tool-result lifecycle | **existing primitive + measurement** (D1) | `execution/observation.ts`, `tool-projections/`, `lifecycle/run-index.ts` (classification into manifest roles) |
| F3 Adaptive pruning / compaction | **not built for the live loop** (D1); pressure + observed compaction built | `prompt/prompt-budget.ts` (`pressureOf`), `execution/tokens.ts` (`visibleContextProfile`) |
| F4 Prompt IR + global budget | **built** (D2) | `src/prompt/{prompt-ir,prompt-budget,prompt-compiler}.ts` |
| F5 Targeted evidence | **built** (D5) | `context/runtime/materializer.ts`, `context/{representations,candidates,selector,evidence-actions}.ts` |
| F6 Structured handoff | **existing (`AgentEnvelope`) + bounded** (D9) | `intelligence/agent-envelope.ts`, `lifecycle/delegate-child.ts` |
| F7 Shared working set | **built** (D3) | `context/runtime/working-set.ts`, `context/dispatch-context-cache.ts` |
| F8 Cache-aware layout | **built; measured effect nil** (D10) | `prompt/cache-layout.ts` |
| F9 System-1 packet | **not built; already satisfied** + measurement (D7) | `decision/system1-decision.ts`, `decision/system1-value.ts` |
| F10 Model capability preflight | **built, passive** (D6) | `execution/model-capability.ts`, `lifecycle/execution-market.ts` |
| F11 Empirical cost model | **built, live** (D8) | `efficiency/execution-cost-model.ts`, `lifecycle/execution-market.ts` |
| F12 Deterministic-first synthesis | **existing** (D11) + bounded | `intelligence/integrate-results.ts` |
| F13 Observability | **built** | `observability/context-ledger.ts` |
| F14 Lifecycle decomposition | **partial, by design** (D12) | `prompt/prompt-runtime.ts`, `lifecycle/run-index.ts` |

## Decisions

Each: **Decision / Evidence / Benefit / Trade-off / Validation.**

### D1 — Do not build a pruner/compactor for the live conversation; measure it

**Decision.** No `RetentionClassifier → Pruner → Compactor` over the agent's history. Instead: bound and
condense every surface CherryOnTop *does* assemble; and record, per dispatch, how much context the model
could see (`visibleContextProfile`: peak, average, and any sharp fall = the runtime compacting itself).

**Evidence.** The history lives in a process inside a Job; `buildCommand` is one string; no adapter drives
the agent turn by turn (ADR Finding 1). Editing the CLI's history would mean owning its loop or replacing
the harness — a different product. The provider-native mechanisms (the CLI's own auto-compaction) already
run; the spec itself says to prefer them.

**Benefit.** No dead machinery, no second transcript store, no LLM summariser on any path. The metrics the
spec asks for (`peak_visible_context`, `compacted_tokens`) are now real numbers from real usage rather than
targets.

**Trade-off.** Long-horizon runs are still bounded only by the CLI's behaviour and `maxTurns`/spend limits.
If a long-horizon benchmark shows the CLI compacts too late, the lever is an adapter that drives turns —
outside this change. The ledger will show it (`peakVisibleTokens`).

**Validation.** `tokens.test.ts` (`visibleContextProfile`), `context-ledger.test.ts`.

**Where retention *did* apply** — surfaces CherryOnTop owns: chat-session memory (first turn + newest turns
verbatim, middle condensed — pre-existing), now with a ladder of three budgets and elision instead of tail
clipping (D13); synthesis inputs (per-child ladders); prerequisite and continuation handoffs (D9);
observations (already indexed by reference with a reduced projection: `run-index.ts`).

### D2 — One budget, two units, verified on the output

**Decision.** `PromptBudget` gives a token ceiling (`usableTokens × argvShare`, after tool schemas, output,
recovery headroom and safety margin) **and** an exact byte ceiling per channel. `compilePrompt` demotes
deterministically (optional blocks lowest priority first, equal priorities largest first, one rung at a
time; then required blocks through their own fallbacks) and **refuses** rather than truncate a required
block. The returned bytes are re-measured before return.

**Evidence.** Reproduced on this machine: `execve` rejects a single argument of 140,000 bytes
(`E2BIG`; the limit is 131,072). The old code clipped each synthesis report to 12,000 characters and
concatenated them, so eleven reports overflowed (`bench:context`: 132,752 bytes → *synthesis lost*;
compiled: 116,752, all eleven agents represented). The execute path had no bound at all: a long issue plus
64 KB of evidence plus conversation plus repo map reached 138 KB.

**Benefit.** The failure mode was a cryptic exec error and a lost synthesis; it is now a bounded prompt or
a stated refusal. Under budget the output is byte-identical to the old assembly (asserted against a copy of
it), so nothing changes until something is actually too big.

**Trade-off.** Token counting stays the repo's `chars/4` estimate (no tokenizer dependency); the byte
ceiling is exact, which is the one that binds. A provider tokenizer can replace the estimator behind the
same function.

**Validation.** `prompt-compiler.test.ts`; `adversarial.test.ts` (1,000 seeded random documents × budgets:
never over budget, required blocks never silently dropped, deterministic); lifecycle test
`node-actor-manager.prompt.test.ts` (a goal that cannot fit is refused and never reaches a sandbox).

### D3 — The manifest is an index of membership; the working set is a projection with policy

**Decision.** `TaskContextManifest` holds refs by role (`workingSet`, `facts`, `decisions`, `artifacts`,
`validation`, `openQuestions`) — nothing else. Goal, constraints, authority stay on the node contract;
phase and uncertainty stay in `EconomicState`. The task is the *root* of a delegation tree, so siblings share
one manifest. The working set replaces the process-local `siblingSelections` map.

**Evidence.** The spec's field list (goal, constraints, uncertainty…) would copy things already owned
elsewhere, which is the exact failure I1 forbids. The old map was keyed by commit only: every task on a
commit shared it, it was lost on restart, and it ignored the grant a dispatch ran under.

**Benefit.** Sharing is now per task, per commit, per grant (repository revision and a scope digest are in the
ref identity, so a stale or over-broad ref cannot alias a current one). Restart-safe.

**Trade-off.** Sharing is still only a *hint* to the selector (same paths chosen again → identical prefix).
It cannot ship a sibling's knowledge into a fresh process, for the reason in D1; the value is prefix stability
and not re-buying selections, not "knowledge reuse".

**Validation.** `working-set.test.ts`, `dispatch-context-cache.test.ts` ("the task working set"),
`adversarial.test.ts` (commit changes under a running task; cross-task and cross-scope).

### D4 — No new table

**Decision.** Manifest revisions live in `memory` (kind `task_context_manifest`), immutable per revision,
trimmed to 16. **One migration**: `memory(kind, key)` index (`0011`).

**Evidence.** The plan's O1 leaves it open; the query pattern is by task. Adding the manifest exposed that
every `memory` reader filters by `(kind, key)` on an unindexed table: at 50,000 rows, recording a 30-path
working set took **1,144 ms**, projecting it **773 ms**; with the index **35 ms** and **12 ms** (also
speeding the pre-existing context store). Guarded by an `EXPLAIN QUERY PLAN` test.

### D5 — Targeted evidence: a rung in the existing ladder, no parser

**Decision.** `representations.ts` already had `reference…signature…snippet…hunk…full`; it gained `symbol`.
The selector's `FullArtifactRequest` now carries the cheapest representation that pays (`symbol` when the
goal named a declaration and its estimated excerpt is under 60% of the file), plus the whole-file price. The
boundary extracts the declaration with three small scanners (braces, indentation, `end`), measures what it
actually sends, and if it cannot delimit the declaration **escalates to the whole file only if that still
pays at its own price**. An excerpt says it is one (range, total, "the rest was not sent"). Files too large
to send whole (> 64 KB) become reachable by excerpt. The boundary now refuses a request raised against
another commit.

**Evidence.** `bench:context`: one function out of a file costs 2–25% of the file (75–98% saved). No parser
dependency was needed for the case that pays; anything unrecognised returns `null`, not a guess.

**Trade-off / risk.** **The economics of *when* to pre-send an excerpt are the existing model's**
(`information-economics.ts`: rediscovery = 3 turns × 2,000 tokens × P(needed)); it prices an anchored file's
discovery at 10%, so a cheap excerpt can newly clear the bar where a whole file never did. Whether the agent
then skips its own read is unmeasured (the repo's earlier finding was that pre-sent stubs were "never
opened"). It is measurable now — the ledger records `materialize` by representation — but not without a paid
run.

### D6 — Model capability "preflight" is passive, process-wide, soft

**Decision.** No active probe. The registry remembers what the runtime itself said (`model … not available on
your plan`, auth errors) keyed by provider/model/account-kind with an expiring cooldown (30 min / 10 min /
backoff for transient), shared by all nodes; success clears it. The market sets a blocked candidate aside as
`model_capability_cooldown:*`.

**Evidence.** A probe is a paid model call or sandbox to avoid a paid sandbox. Before this, `refuseModel` was
per node, so every node re-learned the same fact at the price of a sandbox.

**Guard against false confidence.** The block is *soft*: if it would leave **no** candidate it is set aside and
the existing runtime fallback decides. Account is by credential *kind*, never the credential.

**Validation.** `model-capability.test.ts`; `execution-market.test.ts` (rejection for another node, clearing on
success, fail-open with everything blocked, other account untouched).

### D7 — System-1 packet: already satisfied; added the measurement

**Decision.** No `DecisionPacket`. `refineWithSystem1` already asks only about the winner, only if a different
answer would change the action (`helpfulnessMatters`), only if MetaVOI > 0, at most once per epoch, and logs
expected value, actual cost, whether the decision changed, and `avoidable`. A new class of packet would be a
second name for that arithmetic (the same finding as the 2026-09-12 ADR for the decision engine).
**Added** `summarizeSystem1Value` so "calls per decision, cost, changed-decision rate, avoidable rate" are
computable from the log. System-1 behaviour is untouched (see the preservation gates).

### D8 — Cost model: quantiles, live, priors kept

**Decision.** `estimateQuantiles` (p50/p75/p90) from the dispatch rows, segmented `role→model→effort→taskClass`,
most specific segment with ≥ 5 samples wins, else the static prior. The market prices a candidate at
`p50 + λ(p90−p50)`, `λ = 0.15 + 0.35·qualityFloor + 0.5·budgetSpentShare` (clamped, monotone). Failed and
killed dispatches count. Each priced candidate carries its quantiles; settlement writes
`market.cost_calibration`; `costCalibration(db)` reports coverage.

**Evidence.** The market priced from a *mean* and trusted it from a single sample. One existing test passed only
because a lone 2-token dispatch collapsed the estimate to ~0; it now supplies five (evidence) and says so.

**Risk (stated plainly).** This is live with no offline routing evaluation — by instruction. λ's coefficients are a
starting position, bounded and monotone, not a finding. The `bench:context` calibration table shows the
*estimator* is calibrated on synthetic heavy-tailed data at n = 60 (0.48/0.76/0.89 against 0.5/0.75/0.9) and
noisy below that (n = 20 reads 0.40/0.67/0.96) — which is what the 5-sample floor and the shrinking segments
are for, and why the floor is a floor rather than a target. It says nothing about the world. Real calibration accrues in `market.cost_calibration` and should be read before
trusting the routing change.

### D9 — Handoffs: bounded, not re-architected

**Decision.** `AgentEnvelope` is already the reference-based, scope-checked, revision-named handoff. Not
replaced. What was unbounded: prerequisite reports (4,000 chars × N) and a replacement's continuation text (a
failed attempt's *whole* answer). Now a shared 12,000-character allowance is water-filled across
prerequisites, and continuation keeps head + tail (`fairShares`, `boundFindings`). Finished children are
recorded as `finding` objects in the parent's manifest (`facts`) as their own structured account, not their
transcript. The prerequisite prose stays in the child's goal, as before, because the goal-visible contract is
tested and the child cannot resolve a ref anyway (no live RPC — D1).
**Not built:** delta handoff (R10→R12). A handoff is a short list of refs; nothing to save.

### D10 — Cache-aware layout: formalised, effect nil, opportunity named

**Decision.** `STATIC/TASK_STABLE/SESSION_STABLE/DYNAMIC` with stable-first layout, a prefix boundary and
fingerprints on every receipt.
**Evidence.** The old assembly was already stable-first; the compiled output is byte-identical to it
(`bench:context`: five siblings share one stable prefix, 96% of a prompt). So the measured saving is **zero
bytes**; what it adds is an invariant with tests and a fingerprint that makes any future regression visible.
**Opportunity not taken:** per-node content (definition of done, softTurnTarget) in the system stanza precedes
the messages and would cut a cross-node prefix; moving it to the dynamic tail changes where instructions live
and needs a paid run to justify.

### D11 — Synthesis policy: already deterministic-first

`decideIntegration` already implements nothing → return-one-child → mechanical merge → model, records why,
and offers the mechanical merge to the market as a candidate. Cheap-vs-strong synthesis is the market's
existing tiered-model choice (`synthesize` defaults to Haiku). Built nothing; added only the argv bound (D2).

### D12 — Lifecycle decomposition: the prompt boundary, not a rewrite

`node-actor-manager.ts` lost the three hand-built prompt assemblies (to `prompt-runtime.ts`) and the
post-run manifest/trace bookkeeping (to `run-index.ts`). A `ContextRuntime` facade over selection + boundary +
assembly was **not** created: the boundary reaches into System-1, the economic runtime and progress publishing,
so a facade would either re-export them or move them, adding indirection without a new owner. The plan's own
critic gate says to stop there.

### D13 — Two defects found by attacking the design, fixed

1. **The newest turn of a long chat vanished.** `renderSessionMemory` clipped the *tail* of its body when even
   one line per middle turn exceeded the budget — and the tail is the newest turn, the one "it"/"again" refer
   to. Found by the benchmark's session table. Now the oldest middle lines are elided with a count, the first
   turn is never dropped, and verbatim answers shrink last.
2. **A reference to a large tool output led to the tool *call*, not the output.** `run-index.ts` indexed
   `eventIds[sequence]` where `sequence` is the call's event; the output is in a later event. Found by the
   "large output needed later" test. `Observation.execution.resultSequence` now records where the output is.

## Not built, and why

- Live pruner/compactor/retention classifier (D1). The `prune` and `retain` ledger phases exist; only
  `retain` (manifest revision) and `compact` (observed) are written today.
- `DecisionPacket` (D7), delta handoff (D9), `ContextRuntime` facade (D12), provider tokenizer, embeddings,
  vector store, live context RPC (spec non-goals).
- `range`/`hunk` acquisition at the economic boundary: the ladder and the extractor exist
  (`extractLines`, `hunk` rung) but nothing yet raises a request naming lines.

## What is unverified

- **Nothing here has been run against a real model.** No cluster or credentials in this environment. The
  benchmark measures bytes, tokens, limits and estimator calibration; whether a smaller or re-ordered prompt
  preserves task success is exactly the paid matrix in `bench/run.mjs`, not run.
- Node 20 is installed here (the repo needs ≥ 22): `node-actor-manager.fork-isolation.test.ts` fails, and
  fails identically before any of these changes. `node-actor-manager.plan.test.ts` "still reuses a real
  split" takes ~4.3–4.8 s against Vitest's 5 s default and times out under load; same before and after.
